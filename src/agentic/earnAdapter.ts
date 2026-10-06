/** AGENTIC-EARN-SPEC 3.2, 3.7, 9.2: every Binance-format assumption of Agentic Earn lives in this file, so the morning patch (P1 to P8) is a one-file change.
 *  Nothing here runs a command or reads the chain. The investment ids and preview targets were measured at E0 (2026-10-06); a product with either unset (null) is never deposited into. */
import type { Address, Hex } from "viem";
import { USDT_56 } from "../trade/settlement.js";
import { agenticAddress, agenticUiString } from "./domain.js";
import type { BawResult } from "./baw.js";

export type EarnProtocol = "venus" | "aave-v3";
export type EarnProduct = {
  protocol: EarnProtocol;
  /** The receipt token the deposit mints to the wallet (vUSDT, aBnbUSDT): pinned by contract and checked on the chain at runtime. */
  receiptToken: Address;
  /** Aave only: the pool whose reserve data names the aToken. */
  pool: Address | null;
  /** P1 (measured at E0 2026-10-06, MD here/AGENTIC-EARN-E0-RESULTS.md): Binance's investment id of its USDT Earn row. A null id keeps the product unconfigured (fail closed). */
  investmentId: string | null;
  /** P4 (measured at E0): the allowed `feeAndContract.interactWith.address` values of the preview, lowercase: Venus the vUSDT contract, Aave the v3 Pool. */
  previewTargets: readonly Address[] | null;
};

export const EARN_USDT: Address = agenticAddress(USDT_56);
export const EARN_PRODUCTS: readonly EarnProduct[] = [
  { protocol: "venus", receiptToken: "0xfd5840cd36d94d7229439859c0112a4185bc0255", pool: null,
    investmentId: "5b77bfd8d8f7c18e9ee0d8f331c4d78f56744eed8addbe2e9970c0ef37e763cb", previewTargets: ["0xfd5840cd36d94d7229439859c0112a4185bc0255"] },
  { protocol: "aave-v3", receiptToken: "0xa9251ca9de909cb71783723713b21e4233fbf1b1", pool: "0x6807dc923806fe8fd134338eabca509979a7e0cb",
    investmentId: "9e901e308ea48144dcce3d77f22be8fbc0dbeef09167174a5a5dbb3b05c6a5e8", previewTargets: ["0x6807dc923806fe8fd134338eabca509979a7e0cb"] },
];
/** P7b: the measured USDT debit above the requested amount, in bps of the amount (never above 1 000). 0 until E1. */
export const EARN_USDT_OUT_EXCESS_BPS = 0;
/** P2 (measured at E0): Binance's own protocol ids. Aave is "aave3": `--defiProtocolId aave-v3` answers an empty list. Our internal label stays in evidence, events and the web. */
export const EARN_BINANCE_PROTOCOL: Readonly<Record<EarnProtocol, string>> = { venus: "venus", "aave-v3": "aave3" };
/** P2 and P3 (measured at E0): the list wrapper and row keys. The APY is the integer `apyBps` (a base supply rate: the reward list is USDT only); rows carry no `investable` key. */
const LIST_KEY = "list", ROW_ID_KEY = "investmentId", ROW_PROTOCOL_KEY = "defiProtocolId", ROW_APY_KEY = "apyBps", ROW_INVESTABLE_KEY = "investable";

export const earnConfigured = (p: EarnProduct): boolean => p.investmentId !== null && p.previewTargets !== null && p.previewTargets.length > 0;
export function earnProductOf(products: readonly EarnProduct[], protocol: string): EarnProduct | undefined { return products.find(p => p.protocol === protocol); }

/** The eight Binance DeFi domain names (codes 351761 to 351768): a structured server refusal, rule 26a. SERVICE_ERROR is not one of them. */
export const EARN_SERVER_REFUSALS: ReadonlySet<string> = new Set(["INVESTMENT_NOT_INVESTABLE", "INVESTMENT_NOT_FOUND", "DEFI_TX_SIMULATION_FAILED", "DEFI_SECURITY_RISK_BLOCKED",
  "COMPLIANCE_FAILED", "INSUFFICIENT_BALANCE", "INVESTMENT_NO_POSITION", "POSITION_QUERY_FAILED"]);
/** The three names the CLI raises before any request (F7): nothing was sent. */
const CLIENT_SIDE: ReadonlySet<string> = new Set(["INVALID_PARAMS", "INVALID_AMOUNT", "INVALID_ADDRESS"]);

export type EarnAmount = { amountWei: bigint; ratio: boolean };
const CHAIN = ["--binanceChainId", "56"] as const;
export function earnListArgs(protocol?: EarnProtocol): string[] {
  return ["defi", "investment-list", "--investType", "Earn", ...(protocol === undefined ? [] : ["--defiProtocolId", EARN_BINANCE_PROTOCOL[protocol]]), "--contractAddresses", EARN_USDT, ...CHAIN,
    "--sortField", "apy", "--sortDirection", "DESC", "--page", "1", "--size", "100"];
}
export function earnPreviewArgs(action: "deposit" | "redeem", product: EarnProduct, amount: EarnAmount): string[] {
  return ["defi", "preview", "--action", action, "--investmentId", product.investmentId!, "--tokenAddress", EARN_USDT,
    ...(amount.ratio ? ["--ratio", "1"] : ["--amount", agenticUiString(amount.amountWei)]), ...CHAIN];
}
export function earnDepositArgs(product: EarnProduct, amountWei: bigint): string[] {
  return ["defi", "deposit", "--investmentId", product.investmentId!, "--tokenAddress", EARN_USDT, "--amount", agenticUiString(amountWei), ...CHAIN];
}
export function earnRedeemArgs(product: EarnProduct, amount: EarnAmount): string[] {
  return ["defi", "redeem", "--investmentId", product.investmentId!, "--tokenAddress", EARN_USDT,
    ...(amount.ratio ? ["--ratio", "1"] : ["--amount", agenticUiString(amount.amountWei)]), ...CHAIN];
}
/** The CLI string stored in `from_qty`. */
export const earnQty = (amount: EarnAmount): string => amount.ratio ? "ratio:1" : agenticUiString(amount.amountWei);

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** P3: the base supply APY as the row's integer bps (345 is 3.45 %). Anything else (a string, a fraction, a negative) and any value above 50 % is null: that product is not a candidate. */
export function earnApyBps(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 5_000 ? value : null;
}

export type EarnListing = { protocol: EarnProtocol; apyBps: number };
/** Rows of the list that match a configured product by id and protocol, are not marked not investable, and carry a parseable base APY. */
export function parseEarnList(data: unknown, products: readonly EarnProduct[]): EarnListing[] | null {
  if (!record(data) || !Array.isArray(data[LIST_KEY])) return null;
  const out: EarnListing[] = [];
  for (const row of data[LIST_KEY] as unknown[]) {
    if (!record(row)) continue;
    const product = products.find(p => earnConfigured(p) && p.investmentId === row[ROW_ID_KEY] && EARN_BINANCE_PROTOCOL[p.protocol] === row[ROW_PROTOCOL_KEY]);
    const apy = earnApyBps(row[ROW_APY_KEY]);
    if (product === undefined || row[ROW_INVESTABLE_KEY] === false || apy === null || out.some(o => o.protocol === product.protocol)) continue;
    out.push({ protocol: product.protocol, apyBps: apy });
  }
  return out;
}

/** F4: the preview is read only through its interact-with address. Null means the answer is not a preview object. */
export function parseEarnPreview(data: unknown): { interactWith: Address | null } | null {
  if (!record(data)) return null;
  const fee = data["feeAndContract"], target = record(fee) && record(fee["interactWith"]) ? fee["interactWith"]["address"] : null;
  return { interactWith: typeof target === "string" && /^0x[0-9a-fA-F]{40}$/u.test(target) ? agenticAddress(target) : null };
}

/** P5: the deposit and redeem `data` keys. `delayed` is a non-empty `redeemDelayDays`. */
export function parseEarnTx(data: unknown): { txHash: Hex; delayed: boolean } | null {
  if (!record(data) || typeof data["txHash"] !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(data["txHash"])) return null;
  const delay = data["redeemDelayDays"];
  if (delay !== undefined && delay !== null && !Array.isArray(delay)) return null;
  return { txHash: data["txHash"].toLowerCase() as Hex, delayed: Array.isArray(delay) && delay.length > 0 };
}

export type EarnResponse = { response: "accepted" | "rejected" | "no-response"; txHash: Hex | null; holdReason: string | null; note: string; rollBack: boolean };
/** Rule 22 and R11.1: only a valid transaction hash is accepted; only a client-side name proves nothing was sent; every other answer is held. */
export function earnResponse(action: "deposit" | "redeem", result: BawResult): EarnResponse {
  if (result.kind === "ok") {
    const tx = parseEarnTx(result.data);
    if (tx === null) return { response: "no-response", txHash: null, holdReason: "no-response", note: "unparseable", rollBack: false };
    return { response: "accepted", txHash: tx.txHash, holdReason: action === "redeem" && tx.delayed ? "redeem-delayed" : null, note: "accepted", rollBack: false };
  }
  if (result.kind === "cli-error") {
    if (CLIENT_SIDE.has(result.name)) return { response: "rejected", txHash: null, holdReason: null, note: `cli-error:${result.code}:${result.name}`, rollBack: true };
    return { response: "no-response", txHash: null, holdReason: "no-response", note: `cli-error:${result.code}:${result.name}`, rollBack: false };
  }
  return { response: "no-response", txHash: null, holdReason: "no-response", note: result.kind === "no-response" ? result.code : result.kind, rollBack: false };
}
/** The server name inside a stored `cli_result` of the form `cli-error:<code>:<name>`; null for any other note. */
export function earnCliName(cliResult: string | null): string | null {
  const m = /^cli-error:\d+:([A-Z0-9_]+)$/u.exec(cliResult ?? "");
  return m === null ? null : m[1]!;
}

/** R9: the owner's own withdrawal after a sign-out (signing in ends the 4lpha agent). Null while the product has no investment id. */
export function earnSelfRescueCommand(product: EarnProduct): string | null {
  return product.investmentId === null ? null : `baw defi redeem --investmentId ${product.investmentId} --tokenAddress ${USDT_56} --ratio 1`;
}
