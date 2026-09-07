/**
 * Operator repair: refresh an agent's STORED `sessionFacts` after the owner
 * widened the session ON CHAIN.
 *
 * FOUND LIVE 2026-08-30, arming the first `grid.mode: "shift"` agent.
 * `owner-add-spend-limit` writes ONLY to the chain — it grants the spend limit
 * and the `approve` allowlist entry in two real transactions and never touches
 * the store. Nothing else calls `updateAgentSessionFacts` after provisioning
 * (`scripts/provision-agent.ts:409` is its only writer). Meanwhile the grid
 * arm's base-cap pre-check reads `agent.sessionFacts.spec.spendCaps`
 * (`src/server.ts:4785`) — the STORED snapshot. So a token granted on chain
 * stays invisible to the route and the arm refuses for ever, with a remedy
 * message that names the command the operator has already run.
 *
 * This script closes that gap for ONE token: it VERIFIES the grant exists on
 * chain (`spendInfos` for the session key's `keyHash`) and only then adds the
 * matching entry to the stored snapshot. It signs nothing, sends nothing and
 * spends nothing; refusing to write when the chain does not agree is the whole
 * point.
 *
 * USAGE
 *   node --import tsx --env-file-if-exists=.env --env-file-if-exists=.env.local \
 *     scripts/sync-session-facts.ts --agent-id grid-ladder-1 \
 *     --token 0x0A43fC31a73013089DF59194872Ecae4cAe14444
 *
 * This is a STOPGAP, not the fix. The fix is for `owner-add-spend-limit` to
 * update the store in the same run, or for the arm's pre-check to fall through
 * to the chain the way `preflightExecute` does (PHASE2.4 (z)) instead of
 * refusing on a snapshot it knows can be stale.
 */
import { createPublicClient, getAddress, http, type Address } from "viem";
import { bsc } from "viem/chains";
import { createAgentStore } from "../src/store/agents.js";
import { validateSessionSpec } from "../src/core/session.js";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i < 0 ? undefined : process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} is required.`);
  }
  return value;
};

/** The one read this script makes: what the ACCOUNT says this key may spend. */
const SPEND_INFOS_ABI = [
  {
    type: "function",
    name: "spendInfos",
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

const agentId = arg("agent-id");
const token = getAddress(arg("token") as Address);

const store = await createAgentStore();
const agent = await store.getAgentById(agentId);
if (agent === null) throw new Error(`No agent "${agentId}".`);

const facts = agent.sessionFacts;
if (facts === null) throw new Error(`Agent "${agentId}" has no sessionFacts.`);
const spec = facts.spec;
const stored = spec.spendCaps.find(
  (cap) => cap.token !== undefined && cap.token.toLowerCase() === token.toLowerCase(),
);
if (stored !== undefined) {
  console.log(`${agentId}: ${token} is already in the stored spend caps (limit ${stored.limit}).`);
  console.log("Nothing to do.");
  process.exit(0);
}

// VERIFY ON CHAIN FIRST. A store that claims a cap the account does not grant
// is strictly worse than a stale one: the arm would pass its pre-check and the
// batch would revert at the relay, which is the failure this check exists to
// prevent (FINDINGS (h)/(u)).
// The same endpoint `owner-add-spend-limit` reads mainnet through
// (`scripts/owner-add-spend-limit.ts:259`), so the two agree by construction.
const rpcUrl = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
const keyHash = process.env.SYNC_KEY_HASH;
if (keyHash === undefined || !/^0x[0-9a-fA-F]{64}$/.test(keyHash)) {
  throw new Error(
    "SYNC_KEY_HASH is required: the session key's keyHash, printed by "
      + "`npm run add-spend-limit` as `keyHash : 0x…`. It is the argument "
      + "`spendInfos` takes, and this script will not guess it.",
  );
}

const client = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
const onChain = await client.readContract({
  address: agent.walletAddress,
  abi: SPEND_INFOS_ABI,
  functionName: "spendInfos",
  args: [keyHash as `0x${string}`],
});

const granted = onChain.find(
  (info) => info.token.toLowerCase() === token.toLowerCase(),
);
if (granted === undefined) {
  throw new Error(
    `REFUSING: the account at ${agent.walletAddress} grants this key no spend `
      + `permission for ${token}. Run \`npm run add-spend-limit\` first; this `
      + `script only mirrors a grant that already exists.`,
  );
}

console.log(`chain grants ${token}: limit ${granted.limit}, spent ${granted.spent}`);

const nextSpec = {
  ...spec,
  spendCaps: [
    ...spec.spendCaps,
    { token, limit: granted.limit, period: "day" as const },
  ],
  allowedCalls: [
    ...spec.allowedCalls,
    // The other half a sell needs, and the half `owner-add-spend-limit` grants
    // in its second transaction: target-bound `approve`, never bare-selector.
    { to: token, selector: "approve(address,uint256)" },
  ],
};

// `permissions` is DERIVED from the spec (`provision-agent.ts:411` is the only
// other place it is built). Updating the spec without re-deriving it would
// leave the two halves of one record disagreeing, which is the shape this
// script exists to end, not to reproduce.
const updated = await store.updateAgentSessionFacts(agent.ownerAddress, agentId, {
  ...facts,
  spec: nextSpec,
  permissions: validateSessionSpec(nextSpec),
});
if (updated === null) throw new Error("updateAgentSessionFacts returned null.");

console.log(
  `${agentId}: stored spendCaps ${spec.spendCaps.length} -> `
    + `${updated.sessionFacts?.spec.spendCaps.length}, callRules `
    + `${spec.allowedCalls.length} -> ${updated.sessionFacts?.spec.allowedCalls.length}`,
);
console.log(`${token} mirrored into the stored snapshot at the chain's own limit.`);
