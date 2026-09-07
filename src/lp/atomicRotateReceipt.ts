import { decodeAbiParameters, toEventSelector, type Address, type Hex } from "viem";

export type AtomicRotateReceipt = {
  readonly decreased: { readonly amount0: bigint; readonly amount1: bigint };
  readonly collected: { readonly amount0: bigint; readonly amount1: bigint };
  /** Pool deltas: positive is wallet input, negative is wallet output. */
  readonly swap: { readonly amount0Delta: bigint; readonly amount1Delta: bigint } | null;
  readonly minted: { readonly tokenId: bigint; readonly amount0: bigint; readonly amount1: bigint };
};
export type AtomicRotateReceiptIdentity = {
  readonly oldTokenId: bigint;
  readonly pool: Address;
  readonly nfpm: Address;
  readonly wallet: Address;
};
type Log = { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex };
const DECREASE = toEventSelector("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
const COLLECT = toEventSelector("Collect(uint256,address,uint256,uint256)");
const INCREASE = toEventSelector("IncreaseLiquidity(uint256,uint128,uint256,uint256)");
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const SWAP = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)");
const ZERO = `0x${"0".repeat(64)}`;

/** Combined receipts contain collect and mint transfers as well as the swap. */
export function parseAtomicRotateReceipt(logs: readonly Log[], identity: AtomicRotateReceiptIdentity): AtomicRotateReceipt {
  const fail = (): never => { throw new Error("Atomic rotate receipt evidence is malformed or has unexpected identity/cardinality."); };
  const nfpmLogs = logs.filter(log => log.address.toLowerCase() === identity.nfpm.toLowerCase());
  const one = (topic: Hex): Log => {
    const found = nfpmLogs.filter(log => log.topics[0] === topic);
    if (found.length !== 1 || found[0] === undefined) return fail();
    return found[0];
  };
  const idOf = (log: Log): bigint => {
    if (log.topics.length !== 2 || !/^0x[0-9a-fA-F]{64}$/.test(log.topics[1] ?? "")) return fail();
    return BigInt(log.topics[1]!);
  };
  const liquidityAmounts = (log: Log) => {
    if (log.data.length !== 194) return fail();
    const [liquidity, amount0, amount1] = decodeAbiParameters(
      [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], log.data,
    );
    if (liquidity <= 0n) return fail();
    return { amount0, amount1 };
  };
  try {
    const decrease = one(DECREASE), collect = one(COLLECT), increase = one(INCREASE);
    if (idOf(decrease) !== identity.oldTokenId || idOf(collect) !== identity.oldTokenId) return fail();
    const decreased = liquidityAmounts(decrease);
    if (collect.data.length !== 194) return fail();
    const [recipient, amount0, amount1] = decodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], collect.data,
    );
    if (recipient.toLowerCase() !== identity.wallet.toLowerCase() || amount0 < decreased.amount0 || amount1 < decreased.amount1) return fail();
    const mints = nfpmLogs.filter(log => log.topics[0] === TRANSFER && log.topics[1] === ZERO);
    const mint = mints[0];
    if (mints.length !== 1 || mint === undefined || mint.topics.length !== 4 || mint.data !== "0x") return fail();
    const walletTopic = `0x${identity.wallet.slice(2).toLowerCase().padStart(64, "0")}`;
    if (mint.topics[2]?.toLowerCase() !== walletTopic || !/^0x[0-9a-fA-F]{64}$/.test(mint.topics[3] ?? "")) return fail();
    const tokenId = BigInt(mint.topics[3]!);
    if (tokenId <= 0n || tokenId === identity.oldTokenId || idOf(increase) !== tokenId) return fail();
    const minted = { tokenId, ...liquidityAmounts(increase) };
    const swaps = logs.filter(log => log.topics[0] === SWAP);
    let swap: AtomicRotateReceipt["swap"] = null;
    if (swaps.length > 1) return fail();
    if (swaps[0] !== undefined) {
      const log = swaps[0];
      if (log.address.toLowerCase() !== identity.pool.toLowerCase() || log.topics.length !== 3 || log.data.length !== 450) return fail();
      const [amount0Delta, amount1Delta] = decodeAbiParameters([
        { type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" },
        { type: "int24" }, { type: "uint128" }, { type: "uint128" },
      ], log.data);
      if (!((amount0Delta > 0n && amount1Delta < 0n) || (amount1Delta > 0n && amount0Delta < 0n))) return fail();
      swap = { amount0Delta, amount1Delta };
    }
    if (amount0 - (swap?.amount0Delta ?? 0n) < minted.amount0 || amount1 - (swap?.amount1Delta ?? 0n) < minted.amount1) return fail();
    return { decreased, collected: { amount0, amount1 }, swap, minted };
  } catch { return fail(); }
}
