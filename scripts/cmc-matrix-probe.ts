/**
 * CMC capability matrix probe (operator tool, offline of mainnet writes).
 *
 * Forks BSC mainnet at a pinned block with anvil and drives the REAL account
 * implementation, USDT, Permit2, the CMC settler and the venue routers with
 * throwaway keys, to execute the eight adversarial facts a
 * `CmcReviewedProfile` asserts (CMC-ACTIVATION-SPEC §4).
 *
 * It never writes to mainnet, never reads a key out of `.env*`, and never
 * touches the agent's session ciphertext: the only agent state it reads is the
 * `wallet_address` and the `session_facts.spec` descriptor, over DATABASE_URL.
 *
 * Usage:
 *   node --import tsx scripts/cmc-matrix-probe.ts \
 *     --fork-url <archive-capable BSC RPC> [--fork-block <n>] [--agent <id>]
 *
 * Writes `MD here/CMC-MATRIX-<block>.json` and `.md`; exits non-zero if any
 * trace FAILs.
 *
 * RULING 2026-09-20 (operator, option A) on trace #3: the normative contract
 * is the v2 spec's R2.5 wording — a session approve alone cannot persist a
 * HIGHER allowance. The pass criterion is therefore "the owner's Permit2
 * allowance after the in-cap session approve is <= the allowance before it";
 * the measured zeroing is an AVAILABILITY residual (a compromised trading key
 * or a worker bug can WIPE, never spend, the owner's data budget; the owner
 * tops it up again and trading capital is unaffected). The over-cap sub-case
 * stays in the trace as evidence.
 *
 * DEVIATION from the spec's letter, recorded in the output: intents are
 * submitted by impersonating the Porto orchestrator
 * (`0xaf14…9751`) and calling the account's ERC-7821
 * `execute(mode, encodeCalls(calls, keyHash))` — the exact entry the
 * orchestrator itself uses into the account's GuardedExecutor. Rebuilding an
 * orchestrator `Intent` EIP-712 digest off-chain is not possible here (the
 * orchestrator exposes no `computeDigest` and the relay, which normally
 * produces the digest, does not exist on a fork), so `IntentExecuted` is not
 * emitted and each trace records the receipt status and post-state instead.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, http,
  keccak256, padHex, parseAbi, toFunctionSelector, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeExecuteData } from "viem/experimental/erc7821";
import * as Key from "porto/viem/Key";
import { canonicalEncode } from "../src/auth/canonical.js";
import { CMC_PAYEE, CMC_SIGNER, CMC_SPENDER } from "../src/trade/cmc.js";
import { CMC_PERMIT2, CMC_REVIEWED_TOKEN_CLASSES, grantShapeDigestV1, grantShapeDigestV2 } from "../src/trade/cmcCapability.js";
import { cmcTokenClassCandidates, readCmcTokenClassMembers } from "../src/trade/cmcRpc.js";
import { CMC_SETTLED_TOPIC } from "../src/trade/cmcProof.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { PANCAKE_V2_ROUTER_56, UNISWAP_V3_ROUTER02_56 } from "../src/ops/venues.js";
import { PORTO_V055_ORCHESTRATOR } from "../src/lp/preparedIntent.js";
import { createPgSqlClient } from "../src/store/sql.js";

/* ---------------------------------------------------------------- constants */

const ACCOUNT_IMPLEMENTATION: Address = getAddress("0xc0f16888f4198f53892c53af859f673e23f26fa3");
const UNISWAP_V3_FACTORY_56: Address = getAddress("0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7");
const PANCAKE_V2_FACTORY_56: Address = getAddress("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73");
/** Owner allowance expected after trace 1's +2e18, relative to the wallet's prior Permit2 allowance (set in runMatrix). */
let EXPECTED_OWNER_ALLOWANCE = 2n * 10n ** 18n;
// §3 pins the account implementation by ADDRESS; its code hash is captured here.
const SPEC_TOKEN_CODE_HASH = "0x97a48aa4c129657440dafdacd4c836389734d28cc4a0ca7403e68da660a74a59" as Hex;
const SPEC_PERMIT2_CODE_HASH = "0x48774d936722dd7002887f307f58bcddb3eeabad39149e7dcb5c08e4ebe3310f" as Hex;
const SPEC_SETTLER_CODE_HASH = "0x0ba2481269cc11da9a6208fb34ea1c04cc05152551660b94465f65920b05bb71" as Hex;

const SPEND_PERIODS = ["minute", "hour", "day", "week", "month", "year"] as const;
const ANVIL_PORT = 27_600 + Math.floor(Math.random() * 1_000);

const ACCOUNT_ABI = parseAbi([
  "function getKeys() view returns ((uint40 expiry,uint8 keyType,bool isSuperAdmin,bytes publicKey)[] keys,bytes32[] keyHashes)",
  "function authorize((uint40 expiry,uint8 keyType,bool isSuperAdmin,bytes publicKey) key) returns (bytes32 keyHash)",
  "function revoke(bytes32 keyHash)",
  "function setCanExecute(bytes32 keyHash,address target,bytes4 fnSel,bool can)",
  "function setSpendLimit(bytes32 keyHash,address token,uint8 period,uint256 limit)",
  "function canExecutePackedInfos(bytes32 keyHash) view returns (bytes32[])",
  "function approvedSignatureCheckers(bytes32 keyHash) view returns (address[])",
  "function setSignatureCheckerApproval(bytes32 keyHash,address checker,bool isApproved)",
  "function isValidSignature(bytes32 digest,bytes signature) view returns (bytes4)",
  "function ANY_FN_SEL() view returns (bytes4)",
  "function ANY_TARGET() view returns (address)",
]);
const ERC20_ABI = parseAbi([
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function increaseAllowance(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);
const PERMIT2_ABI = parseAbi(["function nonceBitmap(address,uint256) view returns (uint256)"]);
const SETTLE_ABI = [{
  type: "function", name: "settle", stateMutability: "nonpayable", outputs: [],
  inputs: [
    { name: "permit", type: "tuple", components: [
      { name: "permitted", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] },
    { name: "owner", type: "address" },
    { name: "witness", type: "tuple", components: [{ name: "to", type: "address" }, { name: "validAfter", type: "uint256" }] },
    { name: "signature", type: "bytes" },
  ],
}] as const satisfies Abi;
const UNISWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const PANCAKE_V2_ROUTER_ABI = parseAbi([
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
]);
const V3_FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const V2_FACTORY_ABI = parseAbi(["function createPair(address,address) returns (address)", "function getPair(address,address) view returns (address)"]);
const V2_PAIR_ABI = parseAbi(["function mint(address) returns (uint256)", "function sync()"]);

/**
 * A fork-only ERC-20 whose `transfer` hook tries, as the swap RECIPIENT's
 * output token, to drain the wallet's Permit2 budget: it calls the pinned CMC
 * settler with a forged permit and Permit2 directly with an empty signature.
 * Both attempts are swallowed so the swap itself can still complete; the trace
 * asserts that nothing moved.
 */
const EVIL_SOURCE = `pragma solidity 0.8.30;
struct TokenPermissions { address token; uint256 amount; }
struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }
struct Witness { address to; uint256 validAfter; }
struct TransferDetails { address to; uint256 requestedAmount; }
interface ISettler { function settle(PermitTransferFrom calldata,address,Witness calldata,bytes calldata) external; }
interface IPermit2 { function permitWitnessTransferFrom(PermitTransferFrom calldata,TransferDetails calldata,address,bytes32,string calldata,bytes calldata) external; }
contract EvilOut {
  string public name = "EvilOut"; string public symbol = "EVIL"; uint8 public decimals = 18;
  uint256 public totalSupply; mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance;
  address public settler; address public permit2; address public token; address public victim; address public payee;
  bool public attempted; bool public settleOk; bool public permitOk;
  event Transfer(address indexed from,address indexed to,uint256 value);
  event Approval(address indexed owner,address indexed spender,uint256 value);
  constructor(address s,address p,address t,address v,address y){ settler=s; permit2=p; token=t; victim=v; payee=y; }
  function mint(address to,uint256 amount) external { totalSupply+=amount; balanceOf[to]+=amount; emit Transfer(address(0),to,amount); }
  function approve(address spender,uint256 amount) external returns(bool){ allowance[msg.sender][spender]=amount; emit Approval(msg.sender,spender,amount); return true; }
  function transferFrom(address from,address to,uint256 amount) external returns(bool){ allowance[from][msg.sender]-=amount; _move(from,to,amount); return true; }
  function transfer(address to,uint256 amount) external returns(bool){ _move(msg.sender,to,amount); return true; }
  function _move(address from,address to,uint256 amount) internal {
    balanceOf[from]-=amount; balanceOf[to]+=amount; emit Transfer(from,to,amount);
    if(!attempted){ attempted=true; _attack(); }
  }
  function _attack() internal {
    PermitTransferFrom memory p = PermitTransferFrom(TokenPermissions(token,1e16),7777,block.timestamp+600);
    try ISettler(settler).settle(p,victim,Witness(payee,0),hex"") { settleOk=true; } catch {}
    p.nonce = 7778;
    try IPermit2(permit2).permitWitnessTransferFrom(p,TransferDetails(payee,1e16),victim,bytes32(0),"Witness witness)Witness(address to,uint256 validAfter)TokenPermissions(address token,uint256 amount)",hex"") { permitOk=true; } catch {}
  }
}`;

/* -------------------------------------------------------------------- types */

type Trace = {
  readonly index: number;
  readonly fact: string;
  readonly description: string;
  readonly verdict: "PASS" | "FAIL";
  readonly observations: Readonly<Record<string, unknown>>;
  readonly failures: readonly string[];
  readonly proofDigest: Hex;
};

type Call = { readonly to: Address; readonly value: bigint; readonly data: Hex };

/** The agent descriptor the probe drives; a superset of the grant-shape input. */
type ProbeSpec = {
  readonly allowedCalls: readonly { readonly to?: Address; readonly selector?: string }[];
  readonly spendCaps: readonly { readonly token?: Address; readonly period: string; readonly limit: bigint }[];
  readonly expiresAt: number;
};

type SendResult = {
  readonly status: "success" | "reverted";
  readonly hash: Hex;
  readonly logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
  readonly revertReason: string | null;
};

/* ---------------------------------------------------------------- utilities */

function parseArgs(argv: readonly string[]): { forkUrl: string; forkBlock: number | null; agentId: string } {
  let forkUrl = "";
  let forkBlock: number | null = null;
  let agentId = "trading-agent-01-4";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--fork-url" && value !== undefined) { forkUrl = value; index += 1; }
    else if (flag === "--fork-block" && value !== undefined) { forkBlock = Number.parseInt(value, 10); index += 1; }
    else if (flag === "--agent" && value !== undefined) { agentId = value; index += 1; }
  }
  if (forkUrl === "") throw new Error("--fork-url <archive-capable BSC RPC> is required.");
  return { forkUrl, forkBlock, agentId };
}

function anvilPath(): string {
  const candidate = process.platform === "win32" ? join(homedir(), ".foundry", "bin", "anvil.exe") : join(homedir(), ".foundry", "bin", "anvil");
  return existsSync(candidate) ? candidate : "anvil";
}

function sessionKeyHash(address: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, keccak256(padHex(address, { size: 32 }))]));
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function digestOf(payload: unknown): Hex {
  return keccak256(Buffer.from(canonicalEncode(JSON.parse(JSON.stringify(jsonSafe(payload)))), "utf8"));
}

/** Read the agent's wallet and session descriptor. Ciphertext columns are never selected. */
async function readAgent(agentId: string): Promise<{ wallet: Address; spec: ProbeSpec }> {
  const connection = process.env["DATABASE_URL"]?.trim();
  if (connection === undefined || connection === "") throw new Error("DATABASE_URL is required to read the agent descriptor.");
  const sql = await createPgSqlClient(connection);
  const rows = await sql.query<{ wallet_address: string; session_facts: unknown }>(
    "/* cmc-matrix-probe */ select wallet_address, session_facts from agents where id = $1", [agentId]);
  const row = rows.rows[0];
  if (row === undefined) throw new Error(`agent ${agentId} not found.`);
  const facts = row.session_facts as { spec?: { allowedCalls?: unknown; spendCaps?: unknown; expiresAt?: number } } | null;
  const raw = facts?.spec;
  if (raw === undefined || raw === null || !Array.isArray(raw.allowedCalls) || !Array.isArray(raw.spendCaps)) {
    throw new Error(`agent ${agentId} has no session spec.`);
  }
  const allowedCalls = raw.allowedCalls.map((entry) => {
    const rule = entry as { to?: string; selector?: string };
    return { ...(rule.to === undefined ? {} : { to: getAddress(rule.to) }), ...(rule.selector === undefined ? {} : { selector: rule.selector }) };
  });
  const spendCaps = raw.spendCaps.map((entry) => {
    const cap = entry as { token?: string; period: string; limit: { $bigint?: string } | string | number | bigint };
    const limit = typeof cap.limit === "object" && cap.limit !== null && "$bigint" in cap.limit
      ? BigInt((cap.limit as { $bigint: string }).$bigint) : BigInt(cap.limit as string | number | bigint);
    return { ...(cap.token === undefined ? {} : { token: getAddress(cap.token) }), period: cap.period, limit };
  });
  return { wallet: getAddress(row.wallet_address), spec: { allowedCalls, spendCaps, expiresAt: raw.expiresAt ?? 0 } };
}

async function compileEvil(): Promise<{ abi: Abi; bytecode: Hex }> {
  const module = (await import("solc")) as unknown as { default: { compile(input: string): string; version(): string } };
  if (!module.default.version().startsWith("0.8.30+")) throw new Error("the CMC matrix probe requires solc 0.8.30");
  const output = JSON.parse(module.default.compile(JSON.stringify({
    language: "Solidity", sources: { "Evil.sol": { content: EVIL_SOURCE } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  }))) as { contracts?: Record<string, Record<string, { abi: unknown; evm: { bytecode: { object: string } } }>>; errors?: readonly { severity: string; formattedMessage: string }[] };
  const errors = output.errors?.filter((error) => error.severity === "error") ?? [];
  if (errors.length > 0) throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
  const item = output.contracts?.["Evil.sol"]?.["EvilOut"];
  if (item === undefined) throw new Error("EvilOut compilation produced no artifact.");
  return { abi: item.abi as Abi, bytecode: `0x${item.evm.bytecode.object}` as Hex };
}

/* ------------------------------------------------------------------ runtime */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const agent = await readAgent(args.agentId);
  const grantShapeDigest = grantShapeDigestV1(agent.spec);

  const upstream = createPublicClient({ transport: http(args.forkUrl, { timeout: 45_000 }) });
  const forkBlock = args.forkBlock ?? Number((await upstream.getBlock({ blockTag: "finalized" })).number ?? 0n);
  if (!Number.isSafeInteger(forkBlock) || forkBlock <= 0) throw new Error("could not resolve a fork block.");
  console.log(`[probe] agent=${args.agentId} wallet=${agent.wallet} forkBlock=${forkBlock}`);

  const rpcUrl = `http://127.0.0.1:${ANVIL_PORT}`;
  const chain = { id: 56, name: "bsc-fork", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  let child: ChildProcess | undefined;
  try {
    child = spawn(anvilPath(), ["--silent", "--host", "127.0.0.1", "--port", String(ANVIL_PORT),
      "--fork-url", args.forkUrl, "--fork-block-number", String(forkBlock), "--chain-id", "56"], { stdio: "ignore", windowsHide: true });
    const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 120_000 }) });
    for (let attempt = 0; attempt < 240; attempt += 1) {
      try { await client.getBlockNumber(); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    const traces = await runMatrix({ client, rpcUrl, wallet: agent.wallet, spec: agent.spec, grantShapeDigest, forkBlock });
    // AUDIT (G0, 2026-09-24): identities are read from the archive upstream at the
    // fork block — the chain state the fork starts from. Reading them from anvil
    // after the traces advanced its head timed out (historical eth_getCode).
    const tokenClassMembers = await readCmcTokenClassMembers(upstream, cmcTokenClassCandidates(agent.spec), BigInt(forkBlock));
    const grantShapeDigestClassed = grantShapeDigestV2(agent.spec, new Set(tokenClassMembers.keys()));
    writeReports({ forkBlock, agentId: args.agentId, wallet: agent.wallet, grantShapeDigest,
      grantShapeDigestV2: grantShapeDigestClassed, tokenClassMembers, traces });
    const failed = traces.filter((trace) => trace.verdict === "FAIL");
    console.log(`[probe] ${traces.length - failed.length}/${traces.length} PASS`);
    if (failed.length > 0) {
      for (const trace of failed) console.error(`[probe] FAIL #${trace.index} ${trace.fact}: ${trace.failures.join("; ")}`);
      process.exitCode = 1;
    }
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill();
  }
}

type MatrixContext = {
  readonly client: ReturnType<typeof createPublicClient>;
  readonly rpcUrl: string;
  readonly wallet: Address;
  readonly spec: ProbeSpec;
  readonly grantShapeDigest: Hex;
  readonly forkBlock: number;
};

async function runMatrix(context: MatrixContext): Promise<readonly Trace[]> {
  const { client, rpcUrl, wallet } = context;
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await response.json() as { result?: unknown; error?: { message: string } };
    if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  const fund = async (address: Address): Promise<void> => {
    await rpc("anvil_impersonateAccount", [address]);
    await rpc("anvil_setBalance", [address, "0x3635C9ADC5DEA00000"]);
  };
  const sendFrom = async (from: Address, to: Address, data: Hex): Promise<SendResult> => {
    try {
      const hash = await rpc("eth_sendTransaction", [{ from, to, data, gas: "0x3d0900" }]) as Hex;
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status === "success") return { status: "success", hash, logs: receipt.logs as never, revertReason: null };
      // Replay the exact calldata one block earlier so the trace records WHY.
      let revertReason = "unknown";
      try { await client.call({ account: from, to, data, blockNumber: receipt.blockNumber - 1n, gas: 4_000_000n }); }
      catch (error) { revertReason = (error instanceof Error ? error.message : String(error)).split("\n").slice(0, 4).join(" ").slice(0, 280); }
      return { status: "reverted", hash, logs: [], revertReason };
    } catch (error) {
      return { status: "reverted", hash: `0x${"00".repeat(32)}`, logs: [], revertReason: (error instanceof Error ? error.message : String(error)).slice(0, 280) };
    }
  };
  const read = async <T,>(address: Address, abi: Abi | readonly unknown[], functionName: string, argsList: readonly unknown[] = []): Promise<T> =>
    await client.readContract({ address, abi: abi as Abi, functionName, args: argsList as never }) as T;

  const admin = privateKeyToAccount(`0x${"a1".repeat(32)}` as Hex);
  const session = privateKeyToAccount(`0x${"5e".repeat(32)}` as Hex);
  const adminHash = sessionKeyHash(admin.address);
  const sHash = sessionKeyHash(session.address);

  await fund(wallet);
  await fund(PORTO_V055_ORCHESTRATOR);
  await fund(CMC_SIGNER);
  const deployer = getAddress("0x00000000000000000000000000000000000fD001");
  await fund(deployer);

  const selfCall = async (data: Hex): Promise<void> => {
    const receipt = await sendFrom(wallet, wallet, data);
    if (receipt.status !== "success") throw new Error("impersonated self-call reverted during setup.");
  };
  // A contaminated fork would silently invalidate every trace: the throwaway
  // keys must not already exist on the forked wallet.
  const initialKeys = await read<readonly [readonly unknown[], readonly Hex[]]>(wallet, ACCOUNT_ABI, "getKeys");
  if (initialKeys[1].some((hash) => hash.toLowerCase() === adminHash.toLowerCase() || hash.toLowerCase() === sHash.toLowerCase())) {
    throw new Error("the forked wallet already carries a probe key; the fork is not clean.");
  }
  const anyFnSel = await read<Hex>(wallet, ACCOUNT_ABI, "ANY_FN_SEL");
  const anyTarget = await read<Address>(wallet, ACCOUNT_ABI, "ANY_TARGET");
  const expiry = Math.floor(Date.now() / 1_000) + 7 * 24 * 60 * 60;

  await selfCall(encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "authorize", args: [{ expiry: 0, keyType: 2, isSuperAdmin: true, publicKey: padHex(admin.address, { size: 32 }) }] }));
  await selfCall(encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "authorize", args: [{ expiry, keyType: 2, isSuperAdmin: false, publicKey: padHex(session.address, { size: 32 }) }] }));
  for (const rule of context.spec.allowedCalls) {
    await selfCall(encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setCanExecute", args: [sHash,
      rule.to === undefined ? anyTarget : getAddress(rule.to),
      rule.selector === undefined ? anyFnSel : toFunctionSelector(rule.selector), true] }));
  }
  for (const cap of context.spec.spendCaps) {
    const period = SPEND_PERIODS.indexOf(cap.period as typeof SPEND_PERIODS[number]);
    if (period < 0) throw new Error(`unknown spend period ${cap.period}`);
    await selfCall(encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setSpendLimit", args: [sHash, cap.token ?? getAddress("0x0000000000000000000000000000000000000000"), period, cap.limit] }));
  }

  /** Submit a batch through the account's ERC-7821 orchestrator entry. */
  const intent = async (keyHash: Hex, calls: readonly Call[]) =>
    sendFrom(PORTO_V055_ORCHESTRATOR, wallet, encodeExecuteData({ calls: calls as never, opData: keyHash }));

  const allowance = async (spender: Address): Promise<bigint> => read<bigint>(USDT_56, ERC20_ABI, "allowance", [wallet, spender]);
  const checkers = async (keyHash: Hex): Promise<readonly Address[]> => read<readonly Address[]>(wallet, ACCOUNT_ABI, "approvedSignatureCheckers", [keyHash]);

  const traces: Trace[] = [];
  const record = (index: number, fact: string, description: string, observations: Record<string, unknown>, failures: readonly string[]): void => {
    const body = { index, fact, description, forkBlock: context.forkBlock, observations: jsonSafe(observations) };
    traces.push({ index, fact, description, verdict: failures.length === 0 ? "PASS" : "FAIL", observations: jsonSafe(observations) as Record<string, unknown>, failures, proofDigest: digestOf(body) });
  };

  /* ---- code identity (asserted by every trace) --------------------------- */
  const codeHashOf = async (address: Address): Promise<Hex | null> => {
    const code = await client.getCode({ address, blockNumber: BigInt(context.forkBlock) });
    if (code === undefined || code === "0x") return null;
    if (code.toLowerCase().startsWith("0xef0100") && code.length >= 48) {
      const implementation = getAddress(`0x${code.slice(8, 48)}`);
      const implementationCode = await client.getCode({ address: implementation, blockNumber: BigInt(context.forkBlock) });
      return implementationCode === undefined || implementationCode === "0x" ? null : keccak256(implementationCode);
    }
    return keccak256(code);
  };
  const codeHashes = {
    accountImplementation: ACCOUNT_IMPLEMENTATION,
    accountCodeHash: await codeHashOf(wallet),
    tokenCodeHash: await codeHashOf(USDT_56),
    permit2CodeHash: await codeHashOf(CMC_PERMIT2),
    settlerCodeHash: await codeHashOf(CMC_SPENDER),
  };
  const codeFailures: string[] = [];
  if (codeHashes.tokenCodeHash?.toLowerCase() !== SPEC_TOKEN_CODE_HASH) codeFailures.push("USDT code hash differs from the pinned value");
  if (codeHashes.permit2CodeHash?.toLowerCase() !== SPEC_PERMIT2_CODE_HASH) codeFailures.push("Permit2 code hash differs from the pinned value");
  if (codeHashes.settlerCodeHash?.toLowerCase() !== SPEC_SETTLER_CODE_HASH) codeFailures.push("settler code hash differs from the pinned value");
  const delegated = await client.getCode({ address: wallet, blockNumber: BigInt(context.forkBlock) });
  if (delegated?.toLowerCase() !== `0xef0100${ACCOUNT_IMPLEMENTATION.slice(2).toLowerCase()}`) codeFailures.push("wallet does not delegate to the pinned account implementation");

  /* ---- 1: ownerApprovalPersists ----------------------------------------- */
  // 2026-09-22: a re-hired wallet may already carry a Permit2 allowance from a
  // removed agent; the facts are relative to that prior balance, not to zero.
  const priorAllowance = await allowance(CMC_PERMIT2);
  EXPECTED_OWNER_ALLOWANCE = priorAllowance + 2n * 10n ** 18n;
  const adminIntent = await intent(adminHash, [
    { to: USDT_56, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "increaseAllowance", args: [CMC_PERMIT2, 2n * 10n ** 18n] }) },
    { to: wallet, value: 0n, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setSignatureCheckerApproval", args: [sHash, CMC_PERMIT2, true] }) },
  ]);
  const ownerAllowance = await allowance(CMC_PERMIT2);
  const ownerCheckers = await checkers(sHash);
  record(1, "ownerApprovalPersists", "admin intent: USDT.increaseAllowance(Permit2, 2e18) + setSignatureCheckerApproval(hash(S), Permit2, true)",
    { ...codeHashes, tx: adminIntent.hash, status: adminIntent.status, revertReason: adminIntent.revertReason, allowance: ownerAllowance, checkers: ownerCheckers },
    [...codeFailures,
      ...(adminIntent.status === "success" ? [] : ["admin intent reverted"]),
      ...(ownerAllowance === EXPECTED_OWNER_ALLOWANCE ? [] : [`allowance is ${ownerAllowance} not prior+2e18 (${EXPECTED_OWNER_ALLOWANCE})`]),
      ...(ownerCheckers.some((entry) => entry.toLowerCase() === CMC_PERMIT2.toLowerCase()) ? [] : ["Permit2 is not an approved signature checker for S"])]);

  /* ---- 2: unrelatedTradingPreservesAllowance ---------------------------- */
  const snapshotBeforeTrading = await rpc("evm_snapshot", []) as Hex;
  const venue = await findUniswapPool({ read, spec: context.spec });
  const amountIn = 5n * 10n ** 18n;
  const walletUsdt = await read<bigint>(USDT_56, ERC20_ABI, "balanceOf", [wallet]);
  const tradeFailures: string[] = [];
  let tradeObservations: Record<string, unknown> = { pool: venue, walletUsdtBalance: walletUsdt };
  if (venue === null) tradeFailures.push("no allowlisted Uniswap V3 USDT pool found for the capped token set");
  else if (walletUsdt < amountIn) tradeFailures.push(`wallet holds ${walletUsdt} USDT, below the ${amountIn} trade size`);
  else {
    const swap = await intent(sHash, [
      { to: USDT_56, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [UNISWAP_V3_ROUTER02_56, amountIn] }) },
      { to: UNISWAP_V3_ROUTER02_56, value: 0n, data: encodeFunctionData({ abi: UNISWAP_ROUTER_ABI, functionName: "exactInputSingle",
        args: [{ tokenIn: USDT_56, tokenOut: venue.token, fee: venue.fee, recipient: wallet, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) },
    ]);
    const afterPermit2 = await allowance(CMC_PERMIT2);
    const afterRouter = await allowance(UNISWAP_V3_ROUTER02_56);
    const bought = await read<bigint>(venue.token, ERC20_ABI, "balanceOf", [wallet]);
    tradeObservations = { ...tradeObservations, tx: swap.hash, status: swap.status, revertReason: swap.revertReason, permit2Allowance: afterPermit2, routerAllowance: afterRouter, outputBalance: bought };
    if (swap.status !== "success") tradeFailures.push("the allowlisted session swap reverted");
    if (afterPermit2 !== EXPECTED_OWNER_ALLOWANCE) tradeFailures.push(`Permit2 allowance is ${afterPermit2} after an unrelated trade, not ${EXPECTED_OWNER_ALLOWANCE}`);
    if (afterRouter !== 0n) tradeFailures.push(`router allowance is ${afterRouter} after the trade, not 0`);
  }
  record(2, "unrelatedTradingPreservesAllowance", "session intent: USDT.approve(UniswapV3Router, 5e18) + exactInputSingle(USDT -> capped token)",
    tradeObservations, tradeFailures);
  await rpc("evm_revert", [snapshotBeforeTrading]);

  /* ---- 3: sessionApproveCannotIncreaseAllowance ------------------------- */
  const snapshotBeforeApprove = await rpc("evm_snapshot", []) as Hex;
  // Two sub-cases. (a) is the spec's literal 1e21, which the real USDT day cap
  // refuses outright; (b) is the amount the session CAN actually reach, and it
  // is the one that decides the fact. Per the 2026-09-20 ruling the criterion
  // is "not HIGHER than the owner's allowance"; a zeroing is recorded as
  // `ownerValueRestored: false` (availability residual), not a FAIL.
  const approveFailures: string[] = [];
  const ownerAllowanceBefore = await allowance(CMC_PERMIT2);
  const overCap = await intent(sHash, [
    { to: USDT_56, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [CMC_PERMIT2, 10n ** 21n] }) },
  ]);
  const afterOverCap = await allowance(CMC_PERMIT2);
  if (overCap.status === "success" && afterOverCap > ownerAllowanceBefore) {
    approveFailures.push(`Permit2 allowance is ${afterOverCap} after the over-cap session approve, HIGHER than the owner's ${ownerAllowanceBefore}`);
  }
  const usdtCap = context.spec.spendCaps.find((cap) => cap.token !== undefined && cap.token.toLowerCase() === USDT_56.toLowerCase())?.limit ?? 0n;
  const inCapAmount = usdtCap / 2n;
  const inCap = inCapAmount === 0n ? null : await intent(sHash, [
    { to: USDT_56, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [CMC_PERMIT2, inCapAmount] }) },
  ]);
  const afterInCap = await allowance(CMC_PERMIT2);
  const ownerValueRestored = inCap !== null && inCap.status === "success" && afterInCap === ownerAllowanceBefore;
  if (inCap === null) approveFailures.push("the grant carries no USDT spend cap, so the reachable approve amount is unknown");
  else if (inCap.status === "success" && afterInCap > ownerAllowanceBefore) {
    approveFailures.push(`Permit2 allowance is ${afterInCap} after an in-cap session approve, HIGHER than the owner's ${ownerAllowanceBefore}`);
  }
  const afterDangerous = afterInCap;
  record(3, "sessionApproveCannotIncreaseAllowance", "session intents: USDT.approve(Permit2, 1e21) and USDT.approve(Permit2, half the USDT day cap) - the dangerous shape the v2 grant permits; PASS = the allowance after the in-cap approve is not HIGHER than the owner's",
    { ownerAllowanceBefore, usdtDayCap: usdtCap,
      overCap: { amount: 10n ** 21n, tx: overCap.hash, status: overCap.status, revertReason: overCap.revertReason, allowance: afterOverCap },
      inCap: { amount: inCapAmount, tx: inCap?.hash ?? null, status: inCap?.status ?? null, revertReason: inCap?.revertReason ?? null, allowance: afterInCap },
      ownerAllowanceAfterInCapApprove: afterInCap, ownerValueRestored },
    approveFailures);

  /* ---- 4: noTemporaryApproveConsumePath --------------------------------- */
  const targets = context.spec.allowedCalls.map((rule) => (rule.to === undefined ? "ANY_TARGET" : getAddress(rule.to).toLowerCase()));
  const reachesPermit2 = targets.includes(CMC_PERMIT2.toLowerCase()) || targets.includes("ANY_TARGET");
  const reachesSettler = targets.includes(CMC_SPENDER.toLowerCase());
  const payeeBalance = await read<bigint>(USDT_56, ERC20_ABI, "balanceOf", [CMC_PAYEE]);
  const walletAfterApprove = await read<bigint>(USDT_56, ERC20_ABI, "balanceOf", [wallet]);
  record(4, "noTemporaryApproveConsumePath", "enumerate the granted rules and assert no allowlisted target can pull USDT via Permit2, then re-check the approve-only intent",
    { ruleCount: context.spec.allowedCalls.length, targets, reachesPermit2, reachesSettler, payeeBalance, walletUsdtBalance: walletAfterApprove, allowanceAfterApproveOnly: afterDangerous },
    [...(reachesPermit2 ? ["a granted rule can call Permit2"] : []), ...(reachesSettler ? ["a granted rule can call the CMC settler"] : [])]);
  await rpc("evm_revert", [snapshotBeforeApprove]);

  /* ---- 5: temporaryApproveCallbackReentryExcluded ----------------------- */
  const snapshotBeforeEvil = await rpc("evm_snapshot", []) as Hex;
  const reentryTrace = await runReentryTrace({ rpc, sendFrom, read, client, wallet, deployer, intent, sHash });
  record(5, "temporaryApproveCallbackReentryExcluded", "fork-only malicious output token whose transfer hook calls the settler and Permit2 during an allowlisted session swap",
    reentryTrace.observations, reentryTrace.failures);
  await rpc("evm_revert", [snapshotBeforeEvil]);

  /* ---- 6: revokeExpiryRejectsPayment + the positive settlement ---------- */
  const snapshotBeforeSettle = await rpc("evm_snapshot", []) as Hex;
  const settlement = await runSettlementTrace({ rpc, sendFrom, read, client, wallet, session, sHash, intent });
  record(6, "revokeExpiryRejectsPayment", "sign a Permit2 witness with S, settle it through the pinned settler, then prove expiry and revoke both refuse",
    settlement.observations, settlement.failures);

  /* ---- 8: additiveIncreaseAllowance (continues from the settlement) ----- */
  const settledAllowance = await allowance(CMC_PERMIT2);
  const topUp = await intent(adminHash, [
    { to: USDT_56, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "increaseAllowance", args: [CMC_PERMIT2, 10n ** 18n] }) },
  ]);
  const finalAllowance = await allowance(CMC_PERMIT2);
  const expectedFinal = settledAllowance + 10n ** 18n;
  record(8, "additiveIncreaseAllowance", "after the settlement, an admin increaseAllowance(+1e18) is additive over the remaining allowance",
    { allowanceBefore: settledAllowance, tx: topUp.hash, status: topUp.status, revertReason: topUp.revertReason, allowanceAfter: finalAllowance, expected: expectedFinal },
    [...(topUp.status === "success" ? [] : ["admin top-up intent reverted"]),
      ...(finalAllowance === expectedFinal ? [] : [`allowance is ${finalAllowance}, expected ${expectedFinal}`])]);
  await rpc("evm_revert", [snapshotBeforeSettle]);

  /* ---- 7: walletKeyExclusive (sanity trace) ----------------------------- */
  const keys = await read<readonly [readonly { expiry: bigint; keyType: number; isSuperAdmin: boolean; publicKey: Hex }[], readonly Hex[]]>(wallet, ACCOUNT_ABI, "getKeys");
  record(7, "walletKeyExclusive", "fork key-set sanity trace; the live reader proves exclusivity per read on mainnet",
    { keys: keys[0], keyHashes: keys[1], sessionKeyHash: sHash, adminKeyHash: adminHash }, []);

  return traces.sort((left, right) => left.index - right.index);
}

/* ------------------------------------------------------------ sub-traces */

async function findUniswapPool(input: {
  readonly read: <T>(address: Address, abi: Abi | readonly unknown[], functionName: string, args?: readonly unknown[]) => Promise<T>;
  readonly spec: { readonly spendCaps: readonly { token?: Address }[] };
}): Promise<{ token: Address; fee: number; pool: Address; depth: bigint } | null> {
  let best: { token: Address; fee: number; pool: Address; depth: bigint } | null = null;
  for (const cap of input.spec.spendCaps) {
    const token = cap.token;
    if (token === undefined || token.toLowerCase() === USDT_56.toLowerCase()) continue;
    for (const fee of [100, 500, 3000]) {
      const pool = await input.read<Address>(UNISWAP_V3_FACTORY_56, V3_FACTORY_ABI, "getPool", [USDT_56, token, fee]);
      if (pool === "0x0000000000000000000000000000000000000000") continue;
      const depth = await input.read<bigint>(USDT_56, ERC20_ABI, "balanceOf", [pool]);
      if (best === null || depth > best.depth) best = { token, fee, pool, depth };
    }
  }
  return best !== null && best.depth > 100n * 10n ** 18n ? best : null;
}

type SubTraceDeps = {
  readonly rpc: (method: string, params: readonly unknown[]) => Promise<unknown>;
  readonly sendFrom: (from: Address, to: Address, data: Hex) => Promise<SendResult>;
  readonly read: <T>(address: Address, abi: Abi | readonly unknown[], functionName: string, args?: readonly unknown[]) => Promise<T>;
  readonly client: ReturnType<typeof createPublicClient>;
  readonly wallet: Address;
  readonly intent: (keyHash: Hex, calls: readonly Call[]) => Promise<SendResult>;
  readonly sHash: Hex;
};

async function runReentryTrace(deps: SubTraceDeps & { readonly deployer: Address }): Promise<{ observations: Record<string, unknown>; failures: readonly string[] }> {
  const evil = await compileEvil();
  const deployData = `${evil.bytecode}${encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }],
    [CMC_SPENDER, CMC_PERMIT2, USDT_56, deps.wallet, CMC_PAYEE]).slice(2)}` as Hex;
  const hash = await deps.rpc("eth_sendTransaction", [{ from: deps.deployer, data: deployData, gas: "0x3d0900" }]) as Hex;
  const deployReceipt = await deps.client.waitForTransactionReceipt({ hash });
  const evilAddress = deployReceipt.contractAddress;
  if (evilAddress === null || evilAddress === undefined) return { observations: { deploy: "failed" }, failures: ["could not deploy the malicious output token"] };

  // A fork-only Pancake V2 pair USDT/EvilOut with real reserves: the only way a
  // session-allowlisted call can hand control to foreign code is a swap whose
  // OUTPUT token is that code.
  const pair = await (async (): Promise<Address> => {
    const existing = await deps.read<Address>(PANCAKE_V2_FACTORY_56, V2_FACTORY_ABI, "getPair", [USDT_56, evilAddress]);
    if (existing !== "0x0000000000000000000000000000000000000000") return existing;
    await deps.sendFrom(deps.deployer, PANCAKE_V2_FACTORY_56, encodeFunctionData({ abi: V2_FACTORY_ABI, functionName: "createPair", args: [USDT_56, evilAddress] }));
    return deps.read<Address>(PANCAKE_V2_FACTORY_56, V2_FACTORY_ABI, "getPair", [USDT_56, evilAddress]);
  })();
  await deps.sendFrom(deps.deployer, evilAddress, encodeFunctionData({ abi: evil.abi, functionName: "mint", args: [pair, 1_000n * 10n ** 18n] }));
  // Seeding is fixture setup, not part of the fact under test, so it runs as the
  // (impersonated) wallet itself rather than through the session key: a fee-free
  // grant (FEE_BPS 0) carries no `USDT.transfer` rule, and a session-key seed
  // would be refused before the hook could ever run (2026-10-02, fork 125238707).
  const seedUsdt = await deps.sendFrom(deps.wallet, USDT_56,
    encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [pair, 10n * 10n ** 18n] }));
  await deps.sendFrom(deps.deployer, pair, encodeFunctionData({ abi: V2_PAIR_ABI, functionName: "mint", args: [deps.deployer] }));

  const payeeBefore = await deps.read<bigint>(USDT_56, ERC20_ABI, "balanceOf", [CMC_PAYEE]);
  const bitmapBefore = await deps.read<bigint>(CMC_PERMIT2, PERMIT2_ABI, "nonceBitmap", [deps.wallet, 0n]);
  const swap = await deps.intent(deps.sHash, [
    { to: USDT_56, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PANCAKE_V2_ROUTER_56, 10n ** 18n] }) },
    { to: PANCAKE_V2_ROUTER_56, value: 0n, data: encodeFunctionData({ abi: PANCAKE_V2_ROUTER_ABI, functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      args: [10n ** 18n, 0n, [USDT_56, evilAddress], deps.wallet, BigInt(Math.floor(Date.now() / 1_000) + 600)] }) },
  ]);
  const payeeAfter = await deps.read<bigint>(USDT_56, ERC20_ABI, "balanceOf", [CMC_PAYEE]);
  const bitmapAfter = await deps.read<bigint>(CMC_PERMIT2, PERMIT2_ABI, "nonceBitmap", [deps.wallet, 0n]);
  const permit2Allowance = await deps.read<bigint>(USDT_56, ERC20_ABI, "allowance", [deps.wallet, CMC_PERMIT2]);
  const attempted = await deps.read<boolean>(evilAddress, evil.abi, "attempted");
  const settleOk = await deps.read<boolean>(evilAddress, evil.abi, "settleOk");
  const permitOk = await deps.read<boolean>(evilAddress, evil.abi, "permitOk");
  const settled = swap.logs.some((log) => log.topics[0]?.toLowerCase() === CMC_SETTLED_TOPIC.toLowerCase());

  const failures: string[] = [];
  if (seedUsdt.status !== "success") failures.push("could not seed the fork-only pair");
  if (!attempted) failures.push("the malicious hook never ran, so the trace proves nothing");
  if (settleOk) failures.push("the settler accepted the forged permit from the callback");
  if (permitOk) failures.push("Permit2 accepted an empty signature from the callback");
  if (payeeAfter !== payeeBefore) failures.push(`payee balance moved by ${payeeAfter - payeeBefore}`);
  if (settled) failures.push("Settled was emitted during the swap");
  if (bitmapAfter !== bitmapBefore) failures.push("the Permit2 nonce bitmap changed");
  if (permit2Allowance !== EXPECTED_OWNER_ALLOWANCE) failures.push(`Permit2 allowance is ${permit2Allowance} after the swap, not ${EXPECTED_OWNER_ALLOWANCE}`);
  return {
    observations: { evilAddress, pair, seedTx: seedUsdt.hash, swapTx: swap.hash, swapStatus: swap.status, swapRevertReason: swap.revertReason,
      hookRan: attempted, settleAccepted: settleOk, permit2Accepted: permitOk, settledEmitted: settled,
      payeeBefore, payeeAfter, bitmapBefore, bitmapAfter, permit2Allowance },
    failures,
  };
}

async function runSettlementTrace(deps: SubTraceDeps & { readonly session: ReturnType<typeof privateKeyToAccount> }): Promise<{ observations: Record<string, unknown>; failures: readonly string[] }> {
  const { buildPermit2WitnessTypedData } = await import("@altananetwork/sdk");
  const amount = 10n ** 16n;
  const nonce = 4_242_424_242n;
  const deadline = BigInt(Math.floor(Date.now() / 1_000) + 500);
  const { hashTypedData } = await import("viem");
  const appDigest = hashTypedData(buildPermit2WitnessTypedData({
    chainId: 56, token: USDT_56, amount, spender: CMC_SPENDER, nonce, deadline, to: CMC_PAYEE, validAfter: 0n,
  }) as never);
  const wrapped = hashTypedData({
    domain: { verifyingContract: deps.wallet }, types: { ERC1271Sign: [{ name: "digest", type: "bytes32" }] },
    primaryType: "ERC1271Sign", message: { digest: appDigest },
  });
  const key = Key.fromSecp256k1({ privateKey: `0x${"5e".repeat(32)}` as Hex, role: "session" });
  const signature = await Key.sign(key, { address: null, payload: wrapped });

  // ERC-1271 on this account only answers the APPROVED checker, so the probe
  // must ask exactly as Permit2 does — a caller-less eth_call always fails.
  const askChecker = async (): Promise<Hex> => {
    try {
      const result = await deps.client.call({ account: CMC_PERMIT2, to: deps.wallet,
        data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "isValidSignature", args: [appDigest, signature] }) });
      return (result.data ?? "0x").slice(0, 10) as Hex;
    } catch { return "0xffffffff" as Hex; }
  };
  const magic = await askChecker();
  const settleData = encodeFunctionData({ abi: SETTLE_ABI, functionName: "settle", args: [
    { permitted: { token: USDT_56, amount }, nonce, deadline }, deps.wallet, { to: CMC_PAYEE, validAfter: 0n }, signature] });
  const payeeBefore = await deps.read<bigint>(USDT_56, ERC20_ABI, "balanceOf", [CMC_PAYEE]);
  const settle = await deps.sendFrom(CMC_SIGNER, CMC_SPENDER, settleData);
  const payeeAfter = await deps.read<bigint>(USDT_56, ERC20_ABI, "balanceOf", [CMC_PAYEE]);
  const bitmap = await deps.read<bigint>(CMC_PERMIT2, PERMIT2_ABI, "nonceBitmap", [deps.wallet, nonce >> 8n]);
  const settledEmitted = settle.logs.some((log) => log.topics[0]?.toLowerCase() === CMC_SETTLED_TOPIC.toLowerCase());

  // (b) expiry: move past S's expiry and re-check the same signature.
  const expirySnapshot = await deps.rpc("evm_snapshot", []) as Hex;
  await deps.rpc("evm_increaseTime", [8 * 24 * 60 * 60]);
  await deps.rpc("evm_mine", []);
  const magicAfterExpiry = await askChecker();
  const expiredSettle = await deps.sendFrom(CMC_SIGNER, CMC_SPENDER, encodeFunctionData({ abi: SETTLE_ABI, functionName: "settle", args: [
    { permitted: { token: USDT_56, amount }, nonce: nonce + 1n, deadline: BigInt(Math.floor(Date.now() / 1_000) + 9 * 24 * 60 * 60) }, deps.wallet, { to: CMC_PAYEE, validAfter: 0n }, signature] }));
  await deps.rpc("evm_revert", [expirySnapshot]);

  // (c) revoke: an admin revoke of S refuses the same way.
  const revokeSnapshot = await deps.rpc("evm_snapshot", []) as Hex;
  await deps.sendFrom(deps.wallet, deps.wallet, encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "revoke", args: [deps.sHash] }));
  const magicAfterRevoke = await askChecker();
  const revokedSettle = await deps.sendFrom(CMC_SIGNER, CMC_SPENDER, encodeFunctionData({ abi: SETTLE_ABI, functionName: "settle", args: [
    { permitted: { token: USDT_56, amount }, nonce: nonce + 2n, deadline }, deps.wallet, { to: CMC_PAYEE, validAfter: 0n }, signature] }));
  await deps.rpc("evm_revert", [revokeSnapshot]);

  const failures: string[] = [];
  if (magic.toLowerCase() !== "0x1626ba7e") failures.push(`isValidSignature returned ${magic} while the session is live`);
  if (settle.status !== "success") failures.push("the pinned settler refused a correctly signed live payment");
  if (payeeAfter - payeeBefore !== amount) failures.push(`payee received ${payeeAfter - payeeBefore}, expected ${amount}`);
  if (!settledEmitted) failures.push("Settled was not emitted by the settlement");
  if (magicAfterExpiry.toLowerCase() === "0x1626ba7e") failures.push("isValidSignature still returns the magic value after S expired");
  if (expiredSettle.status === "success") failures.push("the settler accepted a payment signed by an expired session key");
  if (magicAfterRevoke.toLowerCase() === "0x1626ba7e") failures.push("isValidSignature still returns the magic value after S was revoked");
  if (revokedSettle.status === "success") failures.push("the settler accepted a payment signed by a revoked session key");
  return {
    observations: { appDigest, wrappedDigest: wrapped, nonce, deadline, isValidSignature: magic, settleTx: settle.hash, settleStatus: settle.status, settleRevertReason: settle.revertReason,
      payeeBefore, payeeAfter, settledEmitted, nonceBitmap: bitmap,
      isValidSignatureAfterExpiry: magicAfterExpiry, expiredSettleStatus: expiredSettle.status,
      isValidSignatureAfterRevoke: magicAfterRevoke, revokedSettleStatus: revokedSettle.status },
    failures,
  };
}

/* ------------------------------------------------------------------ reports */

function writeReports(input: {
  readonly forkBlock: number; readonly agentId: string; readonly wallet: Address;
  readonly grantShapeDigest: Hex; readonly grantShapeDigestV2: Hex;
  readonly tokenClassMembers: ReadonlyMap<string, string>; readonly traces: readonly Trace[];
}): void {
  const identity = input.traces.find((trace) => trace.index === 1)?.observations ?? {};
  const payload = {
    kind: "cmc-capability-matrix-v1",
    generatedAtMs: Date.now(),
    chainId: 56,
    forkBlock: input.forkBlock,
    agentId: input.agentId,
    wallet: input.wallet,
    grantShapeDigest: input.grantShapeDigest,
    grantShapeDigestV2: input.grantShapeDigestV2,
    tokenClassMembers: Object.fromEntries(input.tokenClassMembers),
    accountCodeHash: (identity as Record<string, unknown>)["accountCodeHash"] ?? null,
    tokenCodeHash: (identity as Record<string, unknown>)["tokenCodeHash"] ?? null,
    permit2CodeHash: (identity as Record<string, unknown>)["permit2CodeHash"] ?? null,
    settlerCodeHash: (identity as Record<string, unknown>)["settlerCodeHash"] ?? null,
    verdict: input.traces.every((trace) => trace.verdict === "PASS") ? "PASS" : "FAIL",
    proofDigests: input.traces.map((trace) => trace.proofDigest),
    traces: input.traces,
  };
  const jsonPath = join("MD here", `CMC-MATRIX-${input.forkBlock}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(jsonSafe(payload), null, 2)}\n`, "utf8");
  const lines = [
    `# CMC capability matrix — BSC fork block ${input.forkBlock}`,
    "",
    `Agent \`${input.agentId}\` · wallet \`${input.wallet}\` · verdict **${payload.verdict}**`,
    "",
    `- account code hash \`${String(payload.accountCodeHash)}\``,
    `- USDT code hash \`${String(payload.tokenCodeHash)}\``,
    `- Permit2 code hash \`${String(payload.permit2CodeHash)}\``,
    `- settler code hash \`${String(payload.settlerCodeHash)}\``,
    `- grant shape digest \`${input.grantShapeDigest}\``,
    `- grant shape digest v2 (reviewed token class) \`${input.grantShapeDigestV2}\``,
    ...CMC_REVIEWED_TOKEN_CLASSES.map((klass) => `- ${klass.classId}: ${[...input.tokenClassMembers.values()].filter((classId) => classId === klass.classId).length} member(s)`),
    "",
    "| # | fact | verdict | proof digest |",
    "|---|---|---|---|",
    ...input.traces.map((trace) => `| ${trace.index} | \`${trace.fact}\` | ${trace.verdict} | \`${trace.proofDigest}\` |`),
    "",
    "## Traces",
    "",
    ...input.traces.flatMap((trace) => [
      `### ${trace.index}. ${trace.fact} — ${trace.verdict}`,
      "",
      trace.description,
      "",
      ...(trace.failures.length === 0 ? [] : [...trace.failures.map((failure) => `- **FAIL**: ${failure}`), ""]),
      "```json",
      JSON.stringify(jsonSafe(trace.observations), null, 2),
      "```",
      "",
    ]),
  ];
  writeFileSync(join("MD here", `CMC-MATRIX-${input.forkBlock}.md`), `${lines.join("\n")}\n`, "utf8");
  console.log(`[probe] wrote ${jsonPath}`);
}

void main().catch((error: unknown) => {
  console.error("[probe]", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
