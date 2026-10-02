/**
 * Auto DCA chain reads and the `dcaRange` UNKNOWN resolver (AUTO-DCA R2.8 as
 * amended by REVIEW2 conditions 1, 3 and 16).
 *
 * ─── THE EVIDENCE (condition 3) ────────────────────────────────────────────
 *
 * `eth_getLogs` is served by one public BSC endpoint and only for roughly the
 * last 8 000–10 000 blocks (REVIEW2 §2.4, measured). So the PRIMARY evidence
 * for "did this batch land" is chain STATE at the finalized tip, available for
 * ever: the pre-submit wallet balance snapshot persisted in the plan (R2.19),
 * each planned exit's liquidity, and the wallet's NFPM enumeration
 * (`balanceOf` + `tokenOfOwnerByIndex`, M5). Logs only CORROBORATE — they find
 * the transaction hash a landed batch's finish needs — over at most
 * {@link DCA_LOG_WINDOW_BLOCKS}, and a failed log read is "no evidence", never
 * absence.
 *
 * Relay `300` is not proof of "not landed" (condition 16): that reading is
 * SDK 0.9.0 documentation (`FINDINGS.md:3680`) and the repo pins 0.7.0, where
 * `toCallsStatusReceipt` maps 300 to PENDING. The relay's answer is printed as
 * a check; it never decides the verdict.
 *
 * ─── WHO WRITES ────────────────────────────────────────────────────────────
 *
 * Nothing here writes. The worker applies the LANDED path automatically — it
 * is the same proof as a live finish (a verified receipt). The NOT-LANDED path
 * is the operator's: `scripts/dca-resolve.ts --apply`, which refuses when any
 * evidence read errored.
 */
import { BaseError, ContractFunctionRevertedError, createPublicClient, fallback, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import type { DcaBatchPlan, DcaPool } from "./dca.js";
import { dcaPoolLegs } from "./dca.js";
import { DCA_NFPM_COLLECT_TOPIC, DCA_NFPM_DECREASE_TOPIC, DCA_NFPM_INCREASE_TOPIC } from "./receipt.js";
import { USDT_56 } from "./settlement.js";

/** Condition 3: no log window is ever wider than this. */
export const DCA_LOG_WINDOW_BLOCKS = 8_000n;
/** R2.8: a batch with no `callsId` is "not landed" only after this long. */
export const DCA_NOT_LANDED_MIN_AGE_MS = 10 * 60 * 1_000;

export type DcaPoolReading = {
  readonly block: bigint;
  readonly tick: number;
  readonly sqrtPriceX96: bigint;
};

export type DcaPositionRead =
  | {
      readonly liquidity: bigint;
      readonly tickLower: number;
      readonly tickUpper: number;
      readonly token0: Address;
      readonly token1: Address;
      readonly fee: number;
    }
  | "burned";

export type DcaNfpmLog = {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly topic: Hex;
};

/** Everything the DCA branch reads from chain, pinned to finalized blocks. */
export type DcaChainReads = {
  /** One finalized reading of the pool's `slot0`. */
  reading(pool: Address): Promise<DcaPoolReading>;
  position(tokenId: bigint, block: bigint): Promise<DcaPositionRead>;
  /** M5: every NFPM token id the wallet owns at `block`. */
  walletTokenIds(wallet: Address, block: bigint): Promise<readonly bigint[]>;
  tokenBalance(token: Address, wallet: Address, block: bigint): Promise<bigint>;
  /** `eth_gasPrice`, for the `dca-uneconomic` hold (bounded by the caller). */
  gasPriceWei(): Promise<bigint>;
  /** Corroboration only: NFPM logs for one token id; the caller caps the window. */
  nfpmLogs(tokenId: bigint, fromBlock: bigint, toBlock: bigint): Promise<readonly DcaNfpmLog[]>;
};

/** §9.3: what the provision route re-reads of the pinned pool at the finalized block (`dca_pool_mismatch`). */
export type DcaPoolIdentity = {
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
};

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);
const NFPM_ABI = parseAbi([
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

/**
 * A burned id, and nothing else (audit H-2): viem wraps transport, timeout,
 * HTTP and node errors in `ContractFunctionExecutionError` too, so only a
 * decoded `ContractFunctionRevertedError` carrying the NFPM's own reason counts.
 */
function isRevert(error: unknown): boolean {
  const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null;
  return reverted instanceof ContractFunctionRevertedError && (reverted.reason ?? "").includes("Invalid token ID");
}

/**
 * The production reads: `eth_call`s over the trade RPC pair (viem `fallback`),
 * logs from the one endpoint that serves them (the CMC discovery precedent).
 */
export function createDcaChainReads(input: {
  readonly rpcUrls: readonly string[];
  readonly logsRpcUrl?: string;
  readonly nfpm: Address;
}): DcaChainReads & { poolIdentity(pool: Address): Promise<DcaPoolIdentity> } {
  const urls = [...new Set(input.rpcUrls.map((url) => url.trim()).filter((url) => url !== ""))];
  if (urls.length === 0) throw new Error("DCA chain reads require at least one BSC RPC URL.");
  const client = createPublicClient({ chain: bsc, transport: fallback(urls.map((url) => http(url, { retryCount: 0 }))) });
  const logs = input.logsRpcUrl === undefined ? null : createPublicClient({ chain: bsc, transport: http(input.logsRpcUrl, { retryCount: 0 }) });
  const nfpm = getAddress(input.nfpm);
  return {
    async reading(pool) {
      const block = await client.getBlock({ blockTag: "finalized" });
      const slot0 = await client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0", blockNumber: block.number });
      return { block: block.number, tick: slot0[1], sqrtPriceX96: slot0[0] };
    },
    async poolIdentity(pool) {
      const block = await client.getBlock({ blockTag: "finalized" });
      const [token0, token1, fee, tickSpacing] = await Promise.all([
        client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0", blockNumber: block.number }),
        client.readContract({ address: pool, abi: POOL_ABI, functionName: "token1", blockNumber: block.number }),
        client.readContract({ address: pool, abi: POOL_ABI, functionName: "fee", blockNumber: block.number }),
        client.readContract({ address: pool, abi: POOL_ABI, functionName: "tickSpacing", blockNumber: block.number }),
      ]);
      return { token0: getAddress(token0), token1: getAddress(token1), fee: Number(fee), tickSpacing: Number(tickSpacing) };
    },
    async position(tokenId, block) {
      try {
        const row = await client.readContract({ address: nfpm, abi: NFPM_ABI, functionName: "positions", args: [tokenId], blockNumber: block });
        return { liquidity: row[7], tickLower: row[5], tickUpper: row[6], token0: getAddress(row[2]), token1: getAddress(row[3]), fee: row[4] };
      } catch (error) {
        // A burned id REVERTS; anything else (transport, node) must not read as burned.
        if (isRevert(error)) return "burned";
        throw error;
      }
    },
    async walletTokenIds(wallet, block) {
      const count = await client.readContract({ address: nfpm, abi: NFPM_ABI, functionName: "balanceOf", args: [wallet], blockNumber: block });
      const ids: bigint[] = [];
      for (let index = 0n; index < count; index += 1n) {
        ids.push(await client.readContract({ address: nfpm, abi: NFPM_ABI, functionName: "tokenOfOwnerByIndex", args: [wallet, index], blockNumber: block }));
      }
      return ids;
    },
    async tokenBalance(token, wallet, block) {
      return client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], blockNumber: block });
    },
    async gasPriceWei() {
      return client.getGasPrice();
    },
    async nfpmLogs(tokenId, fromBlock, toBlock) {
      if (logs === null) throw new Error("No log endpoint is configured.");
      if (toBlock < fromBlock || toBlock - fromBlock > DCA_LOG_WINDOW_BLOCKS) throw new Error("DCA log window exceeds 8 000 blocks.");
      const topicId = `0x${tokenId.toString(16).padStart(64, "0")}` as Hex;
      const rows = await logs.request({ method: "eth_getLogs", params: [{
        address: nfpm, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`,
        topics: [[DCA_NFPM_INCREASE_TOPIC, DCA_NFPM_DECREASE_TOPIC, DCA_NFPM_COLLECT_TOPIC], topicId],
      }] });
      return rows.map((row) => ({ transactionHash: row.transactionHash as Hex, blockNumber: BigInt(row.blockNumber ?? "0x0"), topic: (row.topics[0] ?? "0x") as Hex }));
    },
  };
}

export type DcaChainPosition = {
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
};

/**
 * Condition 1: the wallet's positions in THIS pool with liquidity > 0, from
 * chain, at `block`. Every sweep exits the union of these and the store's live
 * orders, and a stop or Remove is written only once this reads empty.
 */
export async function dcaChainPositions(reads: Pick<DcaChainReads, "walletTokenIds" | "position">, pool: DcaPool, wallet: Address, block: bigint): Promise<readonly DcaChainPosition[]> {
  const legs = dcaPoolLegs(pool);
  const found: DcaChainPosition[] = [];
  for (const tokenId of await reads.walletTokenIds(wallet, block)) {
    const position = await reads.position(tokenId, block);
    if (position === "burned" || position.liquidity <= 0n || position.fee !== pool.fee
      || position.token0.toLowerCase() !== legs.token0.toLowerCase() || position.token1.toLowerCase() !== legs.token1.toLowerCase()) continue;
    found.push({ tokenId, liquidity: position.liquidity, tickLower: position.tickLower, tickUpper: position.tickUpper });
  }
  return found;
}

export type DcaUnknownVerdict = "landed" | "not-landed" | "superseded" | "unclear";

export type DcaUnknownEvidence = {
  readonly verdict: DcaUnknownVerdict;
  /** Some evidence read failed: the verdict is at best `unclear`, and `--apply` refuses. */
  readonly errored: boolean;
  readonly block: bigint | null;
  readonly checks: readonly { readonly name: string; readonly result: string }[];
  /** A token id whose NFPM logs name the landed transaction. */
  readonly landedTokenId: bigint | null;
};

/**
 * The evidence for one `unknown` action, read at the finalized tip.
 *
 *   - SUPERSEDED (AUTO-DCA R4.5, I18): a planned exit reads liquidity 0 (or
 *     burned) and a DIFFERENT `finished` action exited the same token id — A
 *     provably never landed, because that action's verified receipt already
 *     decreased the position to 0 and the plane can never refill it (I11).
 *   - LANDED: a planned exit reads liquidity 0 (or burned) with no such
 *     explanation, or a wallet NFT in the pool carries a planned mint's ticks
 *     and is not an order the store already owns.
 *   - NOT LANDED: every planned exit is at its persisted liquidity, no wallet
 *     NFT matches a planned mint, the wallet's USDT and stock equal the
 *     pre-submit snapshot, and the action is at least ten minutes old.
 *   - otherwise UNCLEAR — hold; the owner's doors are the pull and Remove. An
 *     exit some other in-flight action also plans to exit is UNCLEAR too: it
 *     cannot be judged until that action resolves.
 */
export async function dcaUnknownEvidence(input: {
  readonly reads: Pick<DcaChainReads, "reading" | "position" | "walletTokenIds" | "tokenBalance">;
  readonly pool: DcaPool;
  readonly wallet: Address;
  readonly plan: DcaBatchPlan;
  /** Token ids the store already owns as orders; a match on one of them is not this batch's mint. */
  readonly knownTokenIds: ReadonlySet<bigint>;
  readonly ageMs: number;
  /** The relay's answer for the `callsId`, when the caller read one; printed, never decisive. */
  readonly relayStatus?: string;
  /** Every other action of the agent (A itself excluded); `unknown` ones are ignored (R4.5). */
  readonly others?: readonly { readonly actionKey: string; readonly state: string; readonly txHash: Hex | null; readonly plan: Pick<DcaBatchPlan, "exits"> }[];
}): Promise<DcaUnknownEvidence> {
  const checks: { name: string; result: string }[] = [];
  const { plan, pool, wallet } = input;
  const others = input.others ?? [];
  if (input.relayStatus !== undefined) checks.push({ name: "relay-status", result: `${input.relayStatus} (evidence only, never proof)` });
  let block: bigint;
  try {
    block = (await input.reads.reading(pool.pool)).block;
  } catch {
    checks.push({ name: "finalized-reading", result: "error" });
    return { verdict: "unclear", errored: true, block: null, checks, landedTokenId: null };
  }
  checks.push({ name: "finalized-block", result: block.toString(10) });
  let errored = false;
  let landedTokenId: bigint | null = null;
  let exitsIntact = true;
  let anyBooked = false;
  let anyPending = false;
  const supersededBy = new Map<string, Hex | null>();
  for (const exit of plan.exits) {
    try {
      const position = await input.reads.position(exit.tokenId, block);
      const liquidity = position === "burned" ? 0n : position.liquidity;
      if (liquidity === 0n) landedTokenId ??= exit.tokenId;
      if (liquidity !== exit.liquidity) exitsIntact = false;
      const bookedBy = liquidity === 0n
        ? others.find((row) => row.state === "finished" && row.plan.exits.some((e) => e.tokenId === exit.tokenId))
        : undefined;
      const pendingBy = liquidity !== 0n
        ? others.find((row) => (row.state === "intended" || row.state === "submitted" || row.state === "committed")
          && row.plan.exits.some((e) => e.tokenId === exit.tokenId))
        : undefined;
      if (bookedBy !== undefined) {
        anyBooked = true;
        if (!supersededBy.has(bookedBy.actionKey)) supersededBy.set(bookedBy.actionKey, bookedBy.txHash);
        checks.push({ name: `exit-${exit.tokenId}`, result: `liquidity 0 (persisted ${exit.liquidity}); exited by ${bookedBy.actionKey} (finished, tx ${bookedBy.txHash ?? "none"})` });
      } else if (pendingBy !== undefined) {
        anyPending = true;
        checks.push({ name: `exit-${exit.tokenId}`, result: `liquidity ${liquidity} (persisted ${exit.liquidity}); also exited by ${pendingBy.actionKey} (${pendingBy.state}), not booked yet` });
      } else {
        checks.push({ name: `exit-${exit.tokenId}`, result: `liquidity ${liquidity} (persisted ${exit.liquidity})` });
      }
    } catch {
      errored = true;
      checks.push({ name: `exit-${exit.tokenId}`, result: "error" });
    }
  }
  let mintMatched = false;
  if (plan.mints.length > 0) {
    try {
      const positions = await dcaChainPositions(input.reads, pool, wallet, block);
      for (const mint of plan.mints) {
        const match = positions.find((row) => row.tickLower === mint.tickLower && row.tickUpper === mint.tickUpper && !input.knownTokenIds.has(row.tokenId));
        checks.push({ name: `mint-${mint.orderKey}`, result: match === undefined ? "no wallet NFT with these ticks" : `wallet NFT ${match.tokenId}` });
        if (match !== undefined) {
          mintMatched = true;
          landedTokenId ??= match.tokenId;
        }
      }
    } catch {
      errored = true;
      checks.push({ name: "wallet-enumeration", result: "error" });
    }
  }
  let balancesUnchanged = false;
  if (plan.preSubmit === undefined) {
    checks.push({ name: "pre-submit-snapshot", result: "absent" });
  } else {
    try {
      const [usdt, stock] = await Promise.all([
        input.reads.tokenBalance(USDT_56, wallet, block),
        input.reads.tokenBalance(pool.stock, wallet, block),
      ]);
      balancesUnchanged = usdt === plan.preSubmit.walletUsdtWei && stock === plan.preSubmit.walletStockWei;
      checks.push({ name: "wallet-balances", result: `usdt ${usdt} (was ${plan.preSubmit.walletUsdtWei}); stock ${stock} (was ${plan.preSubmit.walletStockWei})` });
    } catch {
      errored = true;
      checks.push({ name: "wallet-balances", result: "error" });
    }
  }
  checks.push({ name: "age-ms", result: String(input.ageMs) });
  // R4.5: first match wins — booked beats pending beats today's landed/not-landed/unclear logic.
  if (anyBooked) {
    for (const [actionKey, txHash] of supersededBy) checks.push({ name: "superseded-by", result: `${actionKey} tx ${txHash ?? "none"}` });
    return { verdict: "superseded", errored, block, checks, landedTokenId: null };
  }
  if (anyPending) {
    return { verdict: "unclear", errored, block, checks, landedTokenId: null };
  }
  if (landedTokenId !== null && (mintMatched || !exitsIntact)) {
    return { verdict: "landed", errored, block, checks, landedTokenId };
  }
  const notLanded = !errored && exitsIntact && !mintMatched && balancesUnchanged && input.ageMs >= DCA_NOT_LANDED_MIN_AGE_MS;
  return { verdict: notLanded ? "not-landed" : "unclear", errored, block, checks, landedTokenId: null };
}
