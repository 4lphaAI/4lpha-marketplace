/**
 * Drive one live round trip through the running execution plane: buy a token,
 * then sell exactly what the buy delivered, printing both transaction hashes.
 *
 * This is an OPERATOR script, not part of the service. It talks to the service
 * over HTTP the way our own agent runtime will, so what it exercises is the real
 * path: the scan gate, the rule engine, the journal, the on-chain session — none
 * of it is bypassed or stubbed here.
 *
 * WHAT IT QUOTES, AND WHY THAT IS THIS SCRIPT'S JOB AND NOT THE SERVICE'S
 *
 * `/trade` requires `quotedOutWei` and `minOutWei` from its caller, because
 * deciding what a fair price is would be market judgement and the execution
 * plane does not make any. Somebody still has to do it, so this script does:
 * it asks the venue's own quoter (V2 `getAmountsOut`, V3 `QuoterV2`, Four.Meme
 * `tryBuy`/`trySell`), then derives `minOutWei` from `--slippage-bps`. That is
 * the same division the marketplace will follow.
 *
 * WHAT IT WILL NOT DO
 *   - sell before the buy is CONFIRMED. A PENDING or UNKNOWN buy means the
 *     position may not exist, and selling into that is how a test loses money
 *     twice;
 *   - guess the sell size. It reads the wallet's balance before and after the
 *     buy and sells exactly the delta, so a fee-on-transfer token is sold for
 *     what actually arrived rather than what was quoted;
 *   - print a credential, ever.
 *
 * USAGE
 *   npx tsx scripts/live-trade.ts --agent-id test-1 --venue pancake \
 *     --owner-address 0x... --token 0x... --amount 0.002 --confirm i-understand-real-funds
 *
 *   --venue pancake_v3 --fees 100                 (one pool)
 *   --venue pancake_v3 --hops 0x55d3... --fees 500,100   (BNB -> USDT -> token)
 *   --venue fourmeme                              (bonding curve, no route)
 *   --venue flap                                  (bonding curve, no route)
 *   --buy-only                                    (skip the sell leg)
 *   --measure-relay-fee                           (PHASE2.5 F2, see below)
 *
 * `--measure-relay-fee` reads the session's on-chain NATIVE DAY METER
 * (`spendInfos`, the zero-address row at period DAY) before and after each
 * submission and prints the increment. The SELL leg is the number to record: it
 * attaches no native, so its whole delta is the relay's gas reimbursement.
 *
 * That figure is what `RELAY_FEE_PER_EXIT_WEI` has been waiting for. The
 * constant is a 4x pad on ONE sample and PHASE2.5 F2 says plainly that it
 * changes only for the p95 of SEVERAL measurements — a padded guess that looks
 * measured is worse than one that admits it. This flag is the harness; taking
 * the samples is an operator decision, and it spends real BNB.
 */
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { BNB, BNB_TESTNET } from "@altananetwork/sdk";
import { encodeV3Path } from "../src/ops/pancakeV3.js";
import { resolveVenues } from "../src/ops/venues.js";
import { FLAP_PORTAL_ABI } from "../src/ops/abis.js";
import { ACCOUNT_ABI } from "../src/wallet/abis.js";
import { SPEND_PERIOD_DAY, accountKeyHashForAddress } from "../src/wallet/altana.js";
import { RELAY_FEE_PER_EXIT_WEI } from "../src/ops/policy.js";
import {
  createRuntimeAssertionClaims,
  encodeRuntimeAssertion,
  runtimeAssertionPrivateKeyFromBase64Url,
  runtimeAudience,
  runtimeRequestHash,
} from "../src/auth/runtimeAuth.js";
import { parseTradeRequest } from "../src/http/wire.js";
import type { KeyObject } from "node:crypto";

/**
 * Which chain this script quotes on.
 *
 * `EXECUTION_NETWORK` first, because that is the variable the SERVICE reads —
 * agreeing with the thing that will actually execute the trade matters more
 * than agreeing with the spike. `SPIKE_NETWORK` remains a fallback so a shell
 * already set up for a spike run keeps working. Either way the chain-id check
 * against `/status` below is the backstop.
 */
const NETWORK_LABEL =
  (process.env["EXECUTION_NETWORK"] ?? process.env["SPIKE_NETWORK"] ?? "").trim() === "mainnet"
    ? "mainnet"
    : "testnet";
const IS_MAINNET = NETWORK_LABEL === "mainnet";
const NETWORK = IS_MAINNET ? BNB : BNB_TESTNET;
const UNIT = IS_MAINNET ? "BNB" : "tBNB";

/**
 * RPC endpoints for quoting, derived from THIS script's network label.
 *
 * Deliberately not imported from `spike/network.ts`: that module derives its
 * list from `SPIKE_NETWORK`, so importing it made this script announce
 * "MAINNET" while quoting against a testnet node — every quote reverted, and
 * the label check against `/status` could not see it because both labels
 * agreed. The chain-id assertion below is the real fix; this is just the
 * correct source.
 */
const RPC_URLS: readonly string[] = (() => {
  const override = (process.env["SPIKE_RPC_URL"] ?? "").trim();
  const defaults = IS_MAINNET
    ? [
        "https://bsc-dataseed.bnbchain.org",
        "https://bsc-dataseed1.defibit.io",
        NETWORK.publicRpcUrl,
      ]
    : [NETWORK.publicRpcUrl];
  return [...new Set(override === "" ? defaults : [override, ...defaults])];
})();

const MAINNET_CONFIRMATION = "i-understand-real-funds";
const QUOTER_V3: Address = getAddress("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");
const FOURMEME_HELPER: Address = getAddress("0xF251F83e40a78868FcfA3FA4599Dad6494E46034");

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

type Venue = "pancake" | "pancake_v3" | "fourmeme" | "flap";

type Args = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly venue: Venue;
  readonly token: Address;
  /** Native BNB to spend on the buy, in whole BNB. */
  readonly amount: string;
  readonly hops: readonly Address[];
  readonly fees: readonly number[];
  readonly slippageBps: number;
  readonly buyOnly: boolean;
  /**
   * Sell the position the wallet ALREADY holds, without buying first.
   *
   * `--amount` is ignored in this mode: the size is whatever the wallet
   * actually has, read from the chain. Exiting a position you already own is
   * not the place to take a number on trust.
   */
  readonly sellOnly: boolean;
  /** Quote and validate everything, then stop before any trade is submitted. */
  readonly dryRun: boolean;
  /** Ceiling on the price impact this trade may cause, in basis points. */
  readonly maxImpactBps: number;
  /**
   * Read the session's on-chain NATIVE DAY METER either side of each submission
   * and print the increment (PHASE2.5 F2).
   *
   * This is the measurement `RELAY_FEE_PER_EXIT_WEI` has been waiting for since
   * PHASE2.4 D4 item 3. The trade plane had no harness for it at all — `live-lp`
   * has had one since PHASE3.1 and this side never got one, which is exactly why
   * the constant is still a 4x pad on ONE sample.
   */
  readonly measureRelayFee: boolean;
};

function parseArgs(argv: readonly string[]): Args {
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
    if (next !== undefined && !next.startsWith("--")) {
      map.set(arg.slice(2), next);
      i += 1;
    } else {
      map.set(arg.slice(2), "true");
    }
  }

  const need = (name: string): string => {
    const value = map.get(name);
    if (value === undefined || value.trim() === "") {
      throw new Error(`--${name} is required.`);
    }
    return value.trim();
  };

  const venue = need("venue");
  if (
    venue !== "pancake" &&
    venue !== "pancake_v3" &&
    venue !== "fourmeme" &&
    venue !== "flap"
  ) {
    throw new Error(`--venue must be pancake, pancake_v3, fourmeme or flap.`);
  }

  const list = (name: string): string[] => {
    const raw = map.get(name);
    if (raw === undefined || raw.trim() === "" || raw === "true") return [];
    return raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  };

  const slippageBps = Number.parseInt(map.get("slippage-bps") ?? "300", 10);
  if (!Number.isFinite(slippageBps) || slippageBps <= 0 || slippageBps > 500) {
    // The service refuses a floor more than MAX_SLIPPAGE_BPS (default 500)
    // below the quote, so anything above that would be rejected there anyway.
    throw new Error("--slippage-bps must be between 1 and 500.");
  }

  // `--amount` says how much native to spend on a BUY. A sell-only run has
  // nothing to spend — its size comes from the wallet — so requiring it there
  // would only invite a number that is then ignored.
  const sellOnly = map.get("sell-only") === "true";

  return {
    agentId: need("agent-id"),
    ownerAddress: getAddress(need("owner-address")),
    venue,
    token: getAddress(need("token")),
    amount: sellOnly ? (map.get("amount") ?? "0") : need("amount"),
    hops: list("hops").map((h) => getAddress(h)),
    fees: list("fees").map((f) => Number.parseInt(f, 10)),
    slippageBps,
    buyOnly: map.get("buy-only") === "true",
    sellOnly,
    dryRun: map.get("dry-run") === "true",
    maxImpactBps: Number.parseInt(map.get("max-impact-bps") ?? "1000", 10),
    measureRelayFee: map.get("measure-relay-fee") === "true",
  };
}

/* -------------------------------------------------------------------------- */
/* Chain reads: quoting and balances                                          */
/* -------------------------------------------------------------------------- */

const publicClient = createPublicClient({
  transport: http(RPC_URLS[0] ?? NETWORK.publicRpcUrl),
});

/* -------------------------------------------------------------------------- */
/* The native day meter (--measure-relay-fee, PHASE2.5 F2)                    */
/* -------------------------------------------------------------------------- */

type MeterRow = { readonly limit: bigint; readonly currentSpent: bigint };

/**
 * Today's native meter for this agent's session key, read straight from the
 * account.
 *
 * The same `spendInfos` row the service's own gate refuses on, read here
 * INDEPENDENTLY rather than through the service: a measurement taken through
 * the thing being measured proves less, and this script already holds a
 * chain-id-verified client. Identified by the session's PUBLIC key, so nothing
 * secret is needed to take a measurement.
 */
async function readNativeDayMeter(
  wallet: Address,
  publicKey: Hex,
): Promise<MeterRow | null> {
  const keyHash = accountKeyHashForAddress(publicKeyToAddress(publicKey));
  const infos = await publicClient.readContract({
    address: wallet,
    abi: ACCOUNT_ABI,
    functionName: "spendInfos",
    args: [keyHash],
  });
  const day = infos.find(
    (info) => info.token === zeroAddress && Number(info.period) === SPEND_PERIOD_DAY,
  );
  if (day === undefined) return null;
  // `currentSpent`, never `spent`: the first is THIS period's usage, which is
  // what a before/after delta must be taken on (PHASE2.5-REVIEW M2).
  return { limit: day.limit, currentSpent: day.currentSpent };
}

/**
 * Print what one submission actually cost the on-chain native meter.
 *
 * `delta - attachedNative` is the relay's reimbursement. On a SELL the attached
 * native is ZERO, which makes the sell leg the CANONICAL sample: the whole delta
 * is the relay fee, with no venue value and no 4lpha fee mixed into it. On a buy
 * the residue also carries the configured fee transfer, so it is an upper bound
 * rather than a measurement — said here rather than left for the reader to
 * discover after recording the wrong number.
 */
function reportMeterDelta(
  label: string,
  before: MeterRow | null,
  after: MeterRow | null,
  attachedNativeWei: bigint,
  status: string,
): void {
  // PHASE2.5-AUDIT A9 — a delta is only a measurement if something landed. A
  // FAILED, PENDING, ROLLED_BACK or refused submission produces a delta of zero
  // (or, worse, a positive number belonging to some other trade that settled in
  // between) and printing that under the word CANONICAL is how a wrong constant
  // gets recorded as measured.
  if (status !== "CONFIRMED") {
    console.log(
      `  meter       : (not measured — this ${label} came back ${status}, and a ` +
        `meter delta is only a relay fee if a transaction actually landed)`,
    );
    return;
  }
  if (before === null || after === null) {
    console.log(
      `  meter       : (unreadable — this key has no daily native spendInfos row, ` +
        `so there is nothing to measure)`,
    );
    return;
  }
  const delta = after.currentSpent - before.currentSpent;
  const residue = delta - attachedNativeWei;
  console.log(
    `  meter       : currentSpent ${before.currentSpent} -> ${after.currentSpent} wei ` +
      `(delta ${delta}, limit ${after.limit})`,
  );
  console.log(
    `  relay fee   : ~${residue} wei for this ${label} ` +
      `(delta ${delta} - attached ${attachedNativeWei})` +
      (attachedNativeWei === 0n
        ? "  <- CANONICAL: nothing else is in this number"
        : "  <- UPPER BOUND: the 4lpha fee transfer is in here too"),
  );
  console.log(
    `                RELAY_FEE_PER_EXIT_WEI is currently ${RELAY_FEE_PER_EXIT_WEI} wei. ` +
      `Replace it only with the p95 of SEVERAL sell-leg samples (PHASE2.5 F2) — ` +
      `one sample is what made it a guess in the first place.`,
  );
  console.log(
    `                AND THE SAMPLE IS ONLY VALID IF NOTHING ELSE SUBMITTED on this ` +
      `session key between the two reads: the agent runtime or a second operator ` +
      `bills the same meter and lands inside this window (PHASE2.5-AUDIT A9).`,
  );
}

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const V2_ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

const QUOTER_V3_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    name: "quoteExactInput",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const HELPER_ABI = [
  {
    name: "tryBuy",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "funds", type: "uint256" },
    ],
    outputs: [
      { name: "tokenManager", type: "address" },
      { name: "quote", type: "address" },
      { name: "estimatedAmount", type: "uint256" },
      { name: "estimatedCost", type: "uint256" },
      { name: "estimatedFee", type: "uint256" },
      { name: "amountMsgValue", type: "uint256" },
      { name: "amountApproval", type: "uint256" },
      { name: "amountFunds", type: "uint256" },
    ],
  },
  {
    name: "trySell",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "tokenManager", type: "address" },
      { name: "quote", type: "address" },
      { name: "funds", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
] as const;

/**
 * The flap Portal for THIS run's chain, from the same resolver the service
 * uses.
 *
 * Resolved rather than hardcoded so a `VENUE_FLAP_PORTAL` override quotes the
 * same contract the trade will execute against — a floor computed at one Portal
 * and enforced at another is not a floor.
 */
function flapPortalFor(): Address {
  const portal = resolveVenues({ chainId: NETWORK.chainId }).flapPortal;
  if (portal === undefined) {
    throw new Error(`No flap Portal is configured for chain ${NETWORK.chainId}.`);
  }
  return portal;
}

async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

/**
 * Quote one leg at the venue that will execute it.
 *
 * Every path here is a read. Nothing in this function can move a token.
 */
async function quote(input: {
  readonly args: Args;
  readonly side: "buy" | "sell";
  readonly amountInWei: bigint;
  readonly router: Address | undefined;
  readonly wbnb: Address | undefined;
}): Promise<bigint> {
  const { args, side, amountInWei } = input;

  if (args.venue === "flap") {
    // `quoteExactInput` is `nonpayable`, so it is a SIMULATE rather than a
    // read — the Portal mutates internally before returning. Direction is which
    // side holds `address(0)`, exactly as the swap expresses it, and a non-flap
    // address reverts (0x6e8698f2) rather than answering zero, so a bad `--token`
    // fails here instead of quoting a floor for a trade that cannot happen.
    const portal = flapPortalFor();
    const { result } = await publicClient.simulateContract({
      address: portal,
      abi: FLAP_PORTAL_ABI,
      functionName: "quoteExactInput",
      args: [
        side === "buy"
          ? { inputToken: zeroAddress, outputToken: args.token, inputAmount: amountInWei }
          : { inputToken: args.token, outputToken: zeroAddress, inputAmount: amountInWei },
      ],
    });
    return result;
  }

  if (args.venue === "fourmeme") {
    if (side === "buy") {
      const result = await publicClient.readContract({
        address: FOURMEME_HELPER,
        abi: HELPER_ABI,
        functionName: "tryBuy",
        args: [args.token, 0n, amountInWei],
      });
      return result[2];
    }
    const result = await publicClient.readContract({
      address: FOURMEME_HELPER,
      abi: HELPER_ABI,
      functionName: "trySell",
      args: [args.token, amountInWei],
    });
    return result[2];
  }

  const wbnb = input.wbnb;
  if (wbnb === undefined) throw new Error("No WBNB configured for this chain.");
  const buyTokens: Address[] = [wbnb, ...args.hops, args.token];
  const tokens = side === "buy" ? buyTokens : [...buyTokens].reverse();

  if (args.venue === "pancake") {
    const router = input.router;
    if (router === undefined) throw new Error("No V2 router configured for this chain.");
    const amounts = await publicClient.readContract({
      address: router,
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountInWei, tokens],
    });
    return amounts[amounts.length - 1] ?? 0n;
  }

  // V3: the quoter mutates state internally and then reverts, so it is called
  // through `simulateContract` rather than `readContract`.
  const fees = side === "buy" ? args.fees : [...args.fees].reverse();
  if (fees.length === 1) {
    const { result } = await publicClient.simulateContract({
      address: QUOTER_V3,
      abi: QUOTER_V3_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: tokens[0] as Address,
          tokenOut: tokens[tokens.length - 1] as Address,
          amountIn: amountInWei,
          fee: fees[0] as number,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return result[0];
  }
  const { result } = await publicClient.simulateContract({
    address: QUOTER_V3,
    abi: QUOTER_V3_ABI,
    functionName: "quoteExactInput",
    args: [encodeV3Path(tokens, fees), amountInWei],
  });
  return result[0];
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

type TradeOutcome = {
  readonly status: string;
  readonly txHash?: string;
  readonly failureCode?: string;
  readonly deniedBy?: string;
  readonly code?: string;
  readonly reasons?: readonly string[];
  /**
   * The journal's own verdict, and the reason — both live in `meta`, not `data`,
   * on the path where the submit THREW. Without them a purely local refusal
   * (the session's allowlist does not cover this token) prints as a bare
   * `PENDING` and reads like a slow relay, which is how a stuck sell went
   * three rounds of diagnosis pointed at the wrong layer.
   */
  /**
   * The relay's handle on the submission. The ONE thing that makes a PENDING
   * actionable — without it a submitted-but-not-mined trade is unfollowable,
   * and on the memory store the journal that held it dies with the process.
   */
  readonly callsId?: string;
  readonly journalState?: string;
  readonly note?: string;
};

const baseUrl = (process.env["EXECUTION_URL"] ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const execToken = process.env["EXECUTION_API_TOKEN"] ?? "";

type RuntimeSigner = {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly privateKey: KeyObject;
};

function loadRuntimeSigner(): RuntimeSigner {
  const issuer = (process.env["RUNTIME_ASSERTION_ISSUER"] ?? "").trim();
  const keyId = (process.env["RUNTIME_ASSERTION_KEY_ID"] ?? "").trim();
  const privateKey = (process.env["RUNTIME_ASSERTION_PRIVATE_KEY"] ?? "").trim();
  const envSalt = (process.env["EXECUTION_ENV_SALT"] ?? "").trim();
  if (issuer === "" || keyId === "" || privateKey === "" || envSalt === "") {
    throw new Error(
      "RUNTIME_ASSERTION_ISSUER, RUNTIME_ASSERTION_KEY_ID, " +
        "RUNTIME_ASSERTION_PRIVATE_KEY and EXECUTION_ENV_SALT are required.",
    );
  }
  return {
    issuer,
    keyId,
    privateKey: runtimeAssertionPrivateKeyFromBase64Url(privateKey),
    audience: runtimeAudience({ chainId: NETWORK.chainId, envSalt }),
  };
}

function runtimeHeader(input: {
  readonly signer: RuntimeSigner;
  readonly args: Args;
  readonly operation: "agentRead" | "trade";
  readonly params: unknown;
}): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  return encodeRuntimeAssertion(
    createRuntimeAssertionClaims({
      issuer: input.signer.issuer,
      audience: input.signer.audience,
      keyId: input.signer.keyId,
      agentId: input.args.agentId,
      owner: input.args.ownerAddress,
      httpRuntimeProfile: "trade-v1",
      operation: input.operation,
      requestHash: runtimeRequestHash(
        input.operation,
        input.args.agentId,
        input.params,
      ),
      issuedAt,
    }),
    input.signer.privateKey,
  );
}

async function serviceGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { "x-exec-token": execToken, accept: "application/json" },
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${JSON.stringify(body["error"] ?? body)}`);
  }
  return body;
}

async function serviceAgentGet(
  args: Args,
  signer: RuntimeSigner,
): Promise<Record<string, unknown>> {
  const path = `/agents/${args.agentId}`;
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      "x-exec-token": execToken,
      "x-runtime-assertion": runtimeHeader({
        signer,
        args,
        operation: "agentRead",
        params: {},
      }),
      accept: "application/json",
    },
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${JSON.stringify(body["error"] ?? body)}`);
  }
  return body;
}

async function postTrade(
  body: Record<string, unknown>,
  args: Args,
  signer: RuntimeSigner,
): Promise<TradeOutcome> {
  const wireBody = { ...body, agentId: undefined };
  const parsedRequest = parseTradeRequest(wireBody);
  if (!parsedRequest.ok) throw new Error(`trade request invalid: ${parsedRequest.message}`);
  const res = await fetch(`${baseUrl}/agents/${String(body["agentId"])}/trade`, {
    method: "POST",
    headers: {
      "x-exec-token": execToken,
      "x-runtime-assertion": runtimeHeader({
        signer,
        args,
        operation: "trade",
        params: parsedRequest.value,
      }),
      "content-type": "application/json",
    },
    body: JSON.stringify(wireBody),
  });
  const parsed = (await res.json()) as {
    data?: { status?: string; transactionHash?: string; failureCode?: string; callsId?: string };
    meta?: {
      deniedBy?: string;
      code?: string;
      reasons?: string[];
      failureCode?: string;
      journalState?: string;
      note?: string;
    };
    error?: { code?: string; message?: string };
  };
  if (!res.ok) {
    throw new Error(
      `trade -> ${res.status} ${parsed.error?.code ?? "unknown"}: ${parsed.error?.message ?? ""}`,
    );
  }
  // `data.failureCode` on the path that returned a receipt, `meta.failureCode`
  // on the path where the submit threw. Reading only the first is what made a
  // local policy refusal print as a bare PENDING.
  const failureCode = parsed.data?.failureCode ?? parsed.meta?.failureCode;

  return {
    status: parsed.data?.status ?? "UNKNOWN",
    ...(parsed.data?.transactionHash === undefined
      ? {}
      : { txHash: parsed.data.transactionHash }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(parsed.data?.callsId === undefined ? {} : { callsId: parsed.data.callsId }),
    ...(parsed.meta?.journalState === undefined
      ? {}
      : { journalState: parsed.meta.journalState }),
    ...(parsed.meta?.note === undefined ? {} : { note: parsed.meta.note }),
    ...(parsed.meta?.deniedBy === undefined ? {} : { deniedBy: parsed.meta.deniedBy }),
    ...(parsed.meta?.code === undefined ? {} : { code: parsed.meta.code }),
    ...(parsed.meta?.reasons === undefined ? {} : { reasons: parsed.meta.reasons }),
  };
}

function explorer(hash: string): string {
  return IS_MAINNET
    ? `https://bscscan.com/tx/${hash}`
    : `https://testnet.bscscan.com/tx/${hash}`;
}

function report(label: string, outcome: TradeOutcome): void {
  console.log(`\n${label}: ${outcome.status}`);
  if (outcome.journalState !== undefined) console.log(`  journal     : ${outcome.journalState}`);
  if (outcome.failureCode !== undefined) console.log(`  failureCode : ${outcome.failureCode}`);
  if (outcome.note !== undefined) console.log(`  note        : ${outcome.note}`);
  if (outcome.deniedBy !== undefined) {
    console.log(`  deniedBy    : ${outcome.deniedBy}  code: ${outcome.code ?? "-"}`);
  }
  if (outcome.reasons !== undefined && outcome.reasons.length > 0) {
    console.log(`  reasons     : ${outcome.reasons.join(", ")}`);
  }
  if (outcome.txHash !== undefined) console.log(`  tx          : ${explorer(outcome.txHash)}`);
  if (outcome.callsId !== undefined) {
    console.log(`  callsId     : ${outcome.callsId}`);
    if (outcome.status === "PENDING") {
      // A PENDING with a handle is a question that can still be answered; a
      // PENDING without one is a dead end. Print the exact call rather than
      // describing it, because the operator reaching this line is already
      // having a bad time.
      const body = `{"jsonrpc":"2.0","id":1,"method":"wallet_getCallsStatus","params":["${outcome.callsId}"]}`;
      console.log(
        `  follow it   : curl -s -X POST -H 'content-type: application/json' ` +
          `--data '${body}' ${NETWORK.relayUrl ?? "<relay url>"}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (IS_MAINNET && !args.dryRun) {
    const confirm = process.argv.includes(`--confirm=${MAINNET_CONFIRMATION}`)
      ? MAINNET_CONFIRMATION
      : process.argv[process.argv.indexOf("--confirm") + 1];
    if (confirm !== MAINNET_CONFIRMATION) {
      throw new Error(
        `This spends REAL ${UNIT} on chain ${NETWORK.chainId}. ` +
          `Re-run with --confirm ${MAINNET_CONFIRMATION} if that is what you want.`,
      );
    }
  }
  if (execToken === "") {
    throw new Error("EXECUTION_API_TOKEN is unset; the service would answer 401.");
  }
  const runtimeSigner = loadRuntimeSigner();

  // This script picks its chain from SPIKE_NETWORK; the service picks its own
  // from EXECUTION_NETWORK. Nothing forces them to agree, and a disagreement is
  // not a harmless mismatch: the quote would come from one chain's pools while
  // the trade executed against another's, so `minOutWei` — the only slippage
  // floor there is — would be a number from the wrong market. Refuse instead.
  // Ask the RPC what chain it is actually on, rather than trusting the label
  // that selected it. A quoting client pointed at the wrong chain does not fail
  // loudly — it reverts on every venue read, or worse, answers with another
  // chain's prices for an address that happens to exist there.
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== NETWORK.chainId) {
    throw new Error(
      `the quoting RPC reports chain ${rpcChainId} but this run targets ` +
        `${NETWORK.chainId}. Refusing to quote one chain and trade on another.`,
    );
  }

  // And the service must agree, for the same reason: `minOutWei` is the only
  // slippage floor there is, and a floor computed from another market is not a
  // floor at all.
  const status = await serviceGet("/status");
  const serviceChainId = (status["data"] as { chainId?: number } | undefined)?.chainId;
  if (serviceChainId !== NETWORK.chainId) {
    throw new Error(
      `chain mismatch: this script quotes on ${NETWORK.chainId} but the service ` +
        `reports ${String(serviceChainId)}. Set EXECUTION_NETWORK the same for both.`,
    );
  }

  const venues = resolveVenues({ chainId: NETWORK.chainId });
  const amountInWei = parseEther(args.amount);

  const agentBody = await serviceAgentGet(args, runtimeSigner);
  const agent = agentBody["data"] as
    | {
        ownerAddress?: string;
        httpRuntimeProfile?: string;
        walletAddress?: string;
        session?: { publicKey?: string };
      }
    | undefined;
  if (
    getAddress(agent?.ownerAddress ?? "") !== args.ownerAddress ||
    agent?.httpRuntimeProfile !== "trade-v1"
  ) {
    throw new Error("The protected agent view does not match --owner-address and trade-v1.");
  }
  const wallet = getAddress(agent?.walletAddress ?? "");
  // The session's PUBLIC key, straight off the runtime view — it is public by
  // construction and is all `spendInfos` needs to find this key's meter.
  const sessionPublicKey = agent?.session?.publicKey as Hex | undefined;
  if (args.measureRelayFee && sessionPublicKey === undefined) {
    throw new Error(
      "--measure-relay-fee needs the agent's session public key, and this agent " +
        "has no session on the record. Provision it first.",
    );
  }

  /**
   * Submit one trade, report it, and — with `--measure-relay-fee` — read the
   * native day meter either side of it (PHASE2.5 F2).
   *
   * Without the flag this is the submission and its report and nothing else: no
   * extra chain reads on a normal run.
   */
  const submitAndReport = async (
    label: string,
    attachedNativeWei: bigint,
    submit: () => Promise<TradeOutcome>,
  ): Promise<TradeOutcome> => {
    if (!args.measureRelayFee || sessionPublicKey === undefined) {
      const plain = await submit();
      report(label, plain);
      return plain;
    }
    const before = await readNativeDayMeter(wallet, sessionPublicKey);
    const outcome = await submit();
    const after = await readNativeDayMeter(wallet, sessionPublicKey);
    report(label, outcome);
    reportMeterDelta(label, before, after, attachedNativeWei, outcome.status);
    return outcome;
  };
  console.log(`service   : ${baseUrl}`);
  console.log(`network   : ${NETWORK.chainId} (${IS_MAINNET ? "MAINNET" : "testnet"})`);
  console.log(`agent     : ${args.agentId}  wallet ${wallet}`);
  console.log(`venue     : ${args.venue}  token ${args.token}`);
  if (args.hops.length > 0) console.log(`hops      : ${args.hops.join(" -> ")}`);
  if (args.fees.length > 0) console.log(`fees      : ${args.fees.join(", ")}`);
  console.log(`amount in : ${args.amount} ${UNIT} (${amountInWei} wei)`);

  const runId = `live-${Date.now()}`;
  // Both bonding curves refuse a `route` outright (it is not in
  // `ROUTABLE_VENUES`), so sending one would be a 400 rather than an ignored
  // field. Omit it for them regardless of what `--hops`/`--fees` say.
  const routeField =
    args.venue === "fourmeme" || args.venue === "flap"
      ? {}
      : args.hops.length === 0 && args.fees.length === 0
        ? {}
        : { route: { hops: args.hops, fees: args.fees } };

  /**
   * Sell a position that is already in the wallet.
   *
   * Shared by `--sell-only` and by the second half of a round trip, so both
   * paths compute the floor the same way and cannot drift.
   */
  const sellPosition = async (amount: bigint): Promise<void> => {
    const quotedSell = await quote({
      args,
      side: "sell",
      amountInWei: amount,
      router: venues.pancakeRouterV2,
      wbnb: venues.wbnb,
    });
    if (quotedSell <= 0n) throw new Error("The venue quoted zero out for the sell.");
    const minOutSell = (quotedSell * BigInt(10_000 - args.slippageBps)) / 10_000n;
    console.log(
      `quote sell: ${formatEther(quotedSell)} ${UNIT}, floor ${formatEther(minOutSell)} ${UNIT}`,
    );
    if (args.dryRun) {
      console.log(`\n--dry-run: the sell checks out. Nothing was sent.`);
      return;
    }
    // A sell attaches NO native, so its meter delta is the relay's
    // reimbursement and nothing else — the canonical sample for F2.
    await submitAndReport("SELL", 0n, () =>
      postTrade({
        agentId: args.agentId,
        decisionId: `${runId}-sell`,
        venue: args.venue,
        side: "sell",
        token: args.token,
        amountWei: amount.toString(10),
        minOutWei: minOutSell.toString(10),
        quotedOutWei: quotedSell.toString(10),
        ...routeField,
      }, args, runtimeSigner),
    );
  };

  /* ---- SELL-ONLY: exit a position without opening a new one ---- */

  if (args.sellOnly) {
    const held = await balanceOf(args.token, wallet);
    console.log(`\nheld      : ${held} token units`);
    if (held <= 0n) {
      console.log("Nothing to sell: the wallet holds none of this token.");
      return;
    }
    await sellPosition(held);
    return;
  }

  /* ---- BUY ---- */

  const quotedBuy = await quote({
    args,
    side: "buy",
    amountInWei,
    router: venues.pancakeRouterV2,
    wbnb: venues.wbnb,
  });
  if (quotedBuy <= 0n) throw new Error("The venue quoted zero out; there is no route to trade.");
  const minOutBuy =
    (quotedBuy * BigInt(10_000 - args.slippageBps)) / 10_000n;
  console.log(`\nquote buy : ${quotedBuy} token units, floor ${minOutBuy} (-${args.slippageBps}bps)`);

  // ---- price impact, which a quote alone does NOT reveal -------------------
  //
  // `getAmountsOut` answers happily for a pool with dust in it: the number is
  // real, it is simply a terrible price. A drained pair returns nearly the same
  // output whether you put in 0.0003 BNB or 0.002 — you are buying the whole
  // remaining reserve either way, and the trade is a donation.
  //
  // Quoting a 1% probe and scaling it up gives the no-impact price for free,
  // and comparing the two catches exactly that case. This is not a market
  // judgement about whether the token is worth buying; it is a check that the
  // amount being traded is not larger than the venue can absorb.
  const probeIn = amountInWei / 100n;
  if (probeIn > 0n) {
    const probeOut = await quote({
      args,
      side: "buy",
      amountInWei: probeIn,
      router: venues.pancakeRouterV2,
      wbnb: venues.wbnb,
    });
    const noImpact = probeOut * 100n;
    if (noImpact > 0n && quotedBuy < noImpact) {
      const impactBps = ((noImpact - quotedBuy) * 10_000n) / noImpact;
      console.log(`impact    : ~${impactBps} bps at this size`);
      if (impactBps > BigInt(args.maxImpactBps)) {
        throw new Error(
          `price impact ~${impactBps}bps exceeds --max-impact-bps ${args.maxImpactBps}. ` +
            `The pool cannot absorb ${args.amount} ${UNIT} at anything like the quoted rate — ` +
            `trade smaller, pick a deeper venue, or raise the ceiling deliberately.`,
        );
      }
    }
  }

  if (args.dryRun) {
    console.log(
      `\n--dry-run: everything up to submission checks out — chain, agent, venue, ` +
        `route and quote. Nothing was sent and nothing was spent.`,
    );
    return;
  }

  const before = await balanceOf(args.token, wallet);
  // The buy ATTACHES `amountInWei`, so its meter delta carries the trade's own
  // native as well as the relay's — an upper bound, not the measurement. The
  // sell leg above is the one to record.
  const buy = await submitAndReport("BUY", amountInWei, () =>
    postTrade({
      agentId: args.agentId,
      decisionId: `${runId}-buy`,
      venue: args.venue,
      side: "buy",
      token: args.token,
      amountWei: amountInWei.toString(10),
      minOutWei: minOutBuy.toString(10),
      quotedOutWei: quotedBuy.toString(10),
      ...routeField,
    }, args, runtimeSigner),
  );

  if (buy.status !== "CONFIRMED") {
    console.log(
      `\nStopping before the sell: the buy is ${buy.status}, so the position may not exist. ` +
        `Selling into that would be a second loss, not a test.`,
    );
    return;
  }

  // The service confirmed through the relay; THIS script reads through its own
  // RPC, and that node may not have the block yet. Reading the balance straight
  // away therefore races the chain, sees no change, and concludes the buy
  // delivered nothing — which is how three live round trips ended up as three
  // buys with the positions still sitting in the wallet. Wait for the receipt
  // this node can see, then read.
  if (buy.txHash !== undefined) {
    await publicClient.waitForTransactionReceipt({
      hash: buy.txHash as `0x${string}`,
      timeout: 120_000,
    });
  }
  let after = await balanceOf(args.token, wallet);
  // Belt and braces for a node that reports the receipt before its state reads
  // catch up: a few short retries cost nothing and remove the flake entirely.
  for (let attempt = 0; attempt < 5 && after === before; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    after = await balanceOf(args.token, wallet);
  }
  const received = after - before;
  console.log(`\nreceived  : ${received} token units (balance ${before} -> ${after})`);
  if (received <= 0n) {
    console.log(
      "The buy confirmed but the balance did not move after waiting for the receipt. " +
        "Not selling — sell the position by hand once you know what actually arrived.",
    );
    return;
  }
  if (args.buyOnly) {
    console.log("--buy-only: stopping here.");
    return;
  }

  /* ---- SELL ---- */

  await sellPosition(received);
  console.log(`\nRound trip done: in ${args.amount} ${UNIT}, position opened and closed.`);
}

main().catch((error: unknown) => {
  console.error(`\nlive-trade failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
