/** Read-only operator inspection for staged TradFi UNKNOWN rows and session shape. */
import { BNB } from "@altananetwork/sdk";
import { pathToFileURL } from "node:url";
import { createClient, createPublicClient, encodeFunctionData, getAddress, http, keccak256,
  parseAbi, toHex, type Address, type Hex, type Transport } from "viem";
import * as Key from "porto/viem/Key";
import { publicKeyToAddress } from "viem/accounts";
import { prepareCalls } from "porto/viem/RelayActions";
import { validateSessionSpec } from "../src/core/session.js";
import { APPROVE_SELECTOR, TRADFI_GUARD_SWAP_SELECTOR } from "../src/ops/policy.js";
import { PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, UNISWAP_V3_ROUTER02_56 } from "../src/ops/venues.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { resolveLpRpcUrls } from "../src/lp/readers.js";
import { assertPreparedSignedPayloadV1, canonicalProviderPermissionsV1, fingerprintLpFinalCallsV1,
  PORTO_NATIVE_FEE_TOKEN, PORTO_V055_CALL_TYPE, PORTO_V055_INTENT_TYPE,
  PORTO_V055_ORCHESTRATOR, portoQuoteDeficits } from "../src/lp/preparedIntent.js";
import { decodeJsonb } from "../src/store/codec.js";
import { PostgresExecutionJournal, type JournalEntry } from "../src/store/journal.js";
import type { SessionFacts } from "../src/store/agents.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { isTradfiV2Settings, parseTradeSettings } from "../src/trade/settings.js";
import { assessTradeUnknown, createTradeUnknownReads, type TradeUnknownReads } from "../src/trade/unknownResolve.js";
import { USDT_56 } from "../src/trade/route.js";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const APPROVE = parseAbi(["function approve(address spender, uint256 amount)"]);
const ORCHESTRATOR_READS = parseAbi([
  "function INTENT_TYPEHASH() view returns (bytes32)",
  "function CALL_TYPEHASH() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])",
]);

export type ProbeArgs = { readonly kind: "agent" | "check-sessions" | "prepare-shape"; readonly agentId?: string };

export function parseArgs(argv: readonly string[]): ProbeArgs {
  if (argv.length === 1 && argv[0] === "--check-sessions") return { kind: "check-sessions" };
  if (argv.length === 2 && argv[0] === "--agent" && AGENT_ID.test(argv[1] ?? "")) {
    return { kind: "agent", agentId: argv[1]! };
  }
  if (argv.length === 3 && argv[0] === "--prepare-shape" && argv[1] === "--agent" && AGENT_ID.test(argv[2] ?? "")) {
    return { kind: "prepare-shape", agentId: argv[2]! };
  }
  throw new Error("Usage: trade-unknown-probe --check-sessions | --agent <id> | --prepare-shape --agent <id>");
}

export type ProbeAgent = { readonly id: string; readonly ownerAddress: Address; readonly walletAddress: Address;
  readonly status: string; readonly sessionFacts: SessionFacts | null };
export type ProbeReads = {
  readAgent(id: string): Promise<ProbeAgent | null>;
  listTradfiAgents(): Promise<readonly ProbeAgent[]>;
  listUnsettledKeys(owner: Address, agentId: string): Promise<readonly string[]>;
  readJournal(key: string): Promise<JournalEntry | null>;
};

export async function runProbe(input: { readonly args: ProbeArgs; readonly reads: ProbeReads;
  readonly chain?: TradeUnknownReads; readonly print: (line: string) => void; readonly nowMs?: number }): Promise<void> {
  if (input.args.kind === "check-sessions") {
    for (const agent of await input.reads.listTradfiAgents()) {
      const facts = agent.sessionFacts;
      let permissionsEqual = false;
      let expiryEqual = false;
      if (facts !== null) {
        try {
          permissionsEqual = canonicalProviderPermissionsV1(validateSessionSpec(facts.spec, { minSessionSeconds: 0 }))
            === canonicalProviderPermissionsV1(facts.permissions);
          expiryEqual = facts.expiry === facts.spec.expiresAt;
        } catch { /* The operator sees a failed check. */ }
      }
      input.print(`${agent.id}: permissions=${permissionsEqual ? "PASS" : "FAIL"} expiry=${expiryEqual ? "PASS" : "FAIL"}`);
    }
    return;
  }
  if (input.args.kind !== "agent") throw new Error("Prepare-shape requires the public relay probe.");
  const agent = await input.reads.readAgent(input.args.agentId!);
  if (agent === null) throw new Error("Agent was not found.");
  if (input.chain === undefined) throw new Error("RPC reads are unavailable.");
  const chain: TradeUnknownReads = {
    finalizedBlock: () => input.chain!.finalizedBlock(),
    readFinalized: async (tx) => { input.print(`candidate ${tx}`); return input.chain!.readFinalized(tx); },
    accountNonce: async (wallet, seqKey, block) => {
      const value = await input.chain!.accountNonce(wallet, seqKey, block);
      input.print(`nonce gate: seqKey=${seqKey} current=${value} block=${block}`);
      return value;
    },
    blockAtOrBefore: async (timestamp) => {
      const value = await input.chain!.blockAtOrBefore(timestamp);
      input.print(`window from=${value} timestamp=${timestamp}`);
      return value;
    },
    intentExecutedTxHashes: async (wallet, nonce, from, to) => {
      const hashes = await input.chain!.intentExecutedTxHashes(wallet, nonce, from, to);
      input.print(`window ${from}..${to}: ${hashes.length} candidate(s)`);
      return hashes;
    },
  };
  for (const key of await input.reads.listUnsettledKeys(agent.ownerAddress, agent.id)) {
    const journal = await input.reads.readJournal(key);
    if (journal?.state !== "UNKNOWN") continue;
    const verdict = await assessTradeUnknown({ agent: agent as Parameters<typeof assessTradeUnknown>[0]["agent"],
      journal, reads: chain, nowMs: input.nowMs ?? Date.now() });
    input.print(`${key}: ${verdict.kind}${"reason" in verdict ? ` (${verdict.reason})` : ` (${verdict.txHash})`}`);
  }
}

type AgentRow = { readonly id: string; readonly owner_address: string; readonly wallet_address: string;
  readonly status: string; readonly session_facts: unknown };

function decodeAgent(row: AgentRow): ProbeAgent {
  return { id: row.id, ownerAddress: getAddress(row.owner_address), walletAddress: getAddress(row.wallet_address),
    status: row.status, sessionFacts: row.session_facts === null ? null : decodeJsonb(row.session_facts) as SessionFacts };
}

async function readOnly<T>(sql: SqlClient, work: (tx: SqlClient) => Promise<T>): Promise<T> {
  return sql.transaction(async (tx) => { await tx.query("set transaction read only"); return work(tx); });
}

export function pgProbeReads(sql: SqlClient, journal: PostgresExecutionJournal): ProbeReads {
  return {
    async readAgent(id) {
      const row = (await readOnly(sql, (tx) => tx.query<AgentRow>(
        "select id, owner_address, wallet_address, status, session_facts from agents where id=$1", [id]))).rows[0];
      return row === undefined ? null : decodeAgent(row);
    },
    async listTradfiAgents() {
      const rows = (await readOnly(sql, (tx) => tx.query<AgentRow & { readonly params: unknown }>(
        `select a.id, a.owner_address, a.wallet_address, a.status, a.session_facts, s.params
         from agents a join trade_settings s on s.agent_id=a.id and s.owner_address=a.owner_address
         where a.status in ('armed','paused') order by a.id`))).rows;
      return rows.filter((row) => {
        const parsed = parseTradeSettings(decodeJsonb(row.params));
        return parsed.ok && isTradfiV2Settings(parsed.value.effective);
      }).map(decodeAgent);
    },
    async listUnsettledKeys(owner, agentId) {
      const rows = (await readOnly(sql, (tx) => tx.query<{ readonly idempotency_key: string }>(
        "select idempotency_key from trade_intents where owner_address=$1 and agent_id=$2 and state in ('pending','submitted') order by created_at",
        [owner.toLowerCase(), agentId]))).rows;
      return rows.map((row) => row.idempotency_key);
    },
    readJournal: (key) => readOnly(sql, () => journal.get(key)),
  };
}

export async function prepareShape(agent: ProbeAgent, rpcUrl: string, print: (line: string) => void,
  injected?: { readonly prepare: typeof prepareCalls; readonly transport: (url: string) => Transport }): Promise<void> {
  const facts = agent.sessionFacts;
  if (facts === null) throw new Error("Agent has no persisted session facts.");
  const permissions = validateSessionSpec(facts.spec, { minSessionSeconds: 0 });
  if (canonicalProviderPermissionsV1(permissions) !== canonicalProviderPermissionsV1(facts.permissions) ||
      facts.expiry !== facts.spec.expiresAt) throw new Error("Persisted session permissions or expiry differ.");
  const approvalGranted = facts.spec.allowedCalls.some((rule) => rule.to?.toLowerCase() === USDT_56.toLowerCase()
    && (rule.selector === APPROVE_SELECTOR || rule.selector === undefined));
  if (!approvalGranted) throw new Error("The session does not grant USDT approve for the prepare shape check.");
  const spender = facts.spec.allowedCalls.find((rule) => rule.to !== undefined && (
    (rule.selector === undefined && (rule.to.toLowerCase() === PANCAKE_V2_ROUTER_56.toLowerCase()
      || rule.to.toLowerCase() === PANCAKE_V3_ROUTER_56.toLowerCase())) ||
    (rule.to.toLowerCase() === UNISWAP_V3_ROUTER02_56.toLowerCase() && rule.selector?.startsWith("exactInput")) ||
    rule.selector === TRADFI_GUARD_SWAP_SELECTOR))?.to;
  if (spender === undefined) throw new Error("No granted Pancake, Uniswap or aggregator guard target is available for the prepare shape check.");
  const calls = [{ to: USDT_56, data: encodeFunctionData({ abi: APPROVE, functionName: "approve", args: [spender, 0n] }) }];
  const key = Key.fromSecp256k1({ publicKey: facts.publicKey, role: "session", expiry: facts.expiry, permissions });
  if (key.type !== "secp256k1" || key.role !== "session" || key.expiry !== facts.expiry ||
      key.publicKey.toLowerCase() !== publicKeyToAddress(facts.publicKey).toLowerCase() ||
      canonicalProviderPermissionsV1(key.permissions ?? {}) !== canonicalProviderPermissionsV1(permissions) ||
      !/^0x[0-9a-f]{64}$/u.test(Key.hash(key).toLowerCase())) {
    throw new Error("Public-only Porto key differs from the persisted session descriptor.");
  }
  const relayUrl = BNB.relayUrl;
  if (relayUrl === undefined) throw new Error("The BNB relay URL is absent.");
  const client = createClient({ chain: BNB.chain, transport: injected?.transport(relayUrl) ?? http(relayUrl) });
  const prepared = await (injected?.prepare ?? prepareCalls)(client, { account: agent.walletAddress, chain: BNB.chain,
    calls: calls.map((call) => ({ ...call, value: 0n })), key, feeToken: PORTO_NATIVE_FEE_TOKEN });
  const quote = prepared.capabilities.quote.quotes[0];
  try {
    if (prepared.capabilities.quote.quotes.length !== 1 || quote === undefined || quote.chainId !== 56 ||
        quote.orchestrator.toLowerCase() !== PORTO_V055_ORCHESTRATOR ||
        quote.intent.eoa.toLowerCase() !== agent.walletAddress.toLowerCase() ||
        keccak256(quote.intent.executionData) !== fingerprintLpFinalCallsV1(calls).value.executionDataHash ||
        (quote.intent.expiry !== 0n && (quote.intent.expiry <= BigInt(Math.floor(Date.now() / 1_000)) ||
          quote.intent.expiry > BigInt(facts.expiry))) ||
        prepared.key?.type !== key.type || prepared.key.publicKey.toLowerCase() !== key.publicKey.toLowerCase() ||
        prepared.context === undefined || prepared.typedData === undefined ||
        prepared.context.preCall || portoQuoteDeficits(quote).short) {
      throw new Error("Prepared quote identity, expiry, key or deficits failed.");
    }
    assertPreparedSignedPayloadV1({ digest: prepared.digest, quoteIntent: quote.intent, calls });
    print("prepare-shape: PASS");
  } catch (error) {
    print(`prepare-shape: FAIL ${sanitizeMessage(error instanceof Error ? error.message : "unsupported shape")}`);
    print(`typed-data keys: ${Object.keys(prepared.typedData ?? {}).sort().join(",")}`);
    throw error;
  }
  const rpc = createPublicClient({ chain: BNB.chain, transport: injected?.transport(rpcUrl) ?? http(rpcUrl, { retryCount: 0 }) });
  const [intentHash, callHash] = await Promise.all([
    rpc.readContract({ address: PORTO_V055_ORCHESTRATOR, abi: ORCHESTRATOR_READS, functionName: "INTENT_TYPEHASH" }),
    rpc.readContract({ address: PORTO_V055_ORCHESTRATOR, abi: ORCHESTRATOR_READS, functionName: "CALL_TYPEHASH" }),
  ]);
  print(`INTENT_TYPEHASH: ${intentHash === keccak256(toHex(PORTO_V055_INTENT_TYPE)) ? "PASS" : "FAIL"}`);
  print(`CALL_TYPEHASH: ${callHash === keccak256(toHex(PORTO_V055_CALL_TYPE)) ? "PASS" : "FAIL"}`);
  let domain: readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]] | undefined;
  try {
    domain = await rpc.readContract({ address: PORTO_V055_ORCHESTRATOR, abi: ORCHESTRATOR_READS, functionName: "eip712Domain" });
  } catch { print("eip712Domain: unavailable"); }
  if (domain !== undefined) {
    const equal = domain[1] === "Orchestrator" && domain[2] === "0.5.5" && domain[3] === 56n &&
      domain[4].toLowerCase() === PORTO_V055_ORCHESTRATOR;
    print(`eip712Domain: ${equal ? "PASS" : "FAIL"}`);
    if (!equal) throw new Error("Orchestrator EIP-712 domain differs from the pinned version.");
  }
  if (intentHash !== keccak256(toHex(PORTO_V055_INTENT_TYPE)) || callHash !== keccak256(toHex(PORTO_V055_CALL_TYPE))) {
    throw new Error("Orchestrator typehash differs from the pinned version.");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const database = process.env["DATABASE_URL"]?.trim();
  if (database === undefined || database === "") throw new Error("DATABASE_URL is required.");
  const sql = await createPgSqlClient(database);
  try {
    const journal = await PostgresExecutionJournal.attachExisting(sql);
    const reads = pgProbeReads(sql, journal);
    const network = { chain: BNB.chain, chainId: BNB.chainId, publicRpcUrl: BNB.publicRpcUrl };
    const rpcUrls = resolveLpRpcUrls(process.env, network);
    if (args.kind === "prepare-shape") {
      const agent = await reads.readAgent(args.agentId!);
      if (agent === null) throw new Error("Agent was not found.");
      await prepareShape(agent, rpcUrls[0]!, console.log);
    } else {
      await runProbe({ args, reads, print: console.log,
        ...(args.kind === "agent" ? { chain: createTradeUnknownReads({ rpcUrls: [rpcUrls[0]!, rpcUrls[1]!], logsRpcUrl: rpcUrls[2]! }) } : {}) });
    }
  } finally { await sql.close(); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`[trade-unknown-probe] ${sanitizeMessage(error instanceof Error ? error.message : "failed")}`);
    process.exitCode = 1;
  });
}
