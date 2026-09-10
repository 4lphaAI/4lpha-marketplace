import type { AccountCoverageReason, AccountPortfolio } from "./types";

type Row = Record<string, unknown>;
const STATES = new Set(["complete", "partial", "empty", "unavailable"]);
const REASONS = new Set<AccountCoverageReason>(["none", "capacity", "dependency", "stale", "unpriced", "unreadable", "identity-conflict", "unsupported-profile", "zero-basis", "missing-mark", "held", "declared", "shared-wallet"]);
const REASON_ORDER = ["none", "capacity", "dependency", "stale", "unpriced", "unreadable", "identity-conflict", "unsupported-profile", "zero-basis", "missing-mark", "held", "declared", "shared-wallet"] as const;
const STATUSES = new Set(["provisioning", "armed", "paused", "revoked", "retired"]);
const PROFILES = new Set(["unbound-v1", "trade-v1", "raw-v1", "lp-v1", "venus-v1"]);
// AGENT-GAS-ATTENTION §3.1 — the two derived states join the explicit ones.
const ATTENTION = new Set(["none", "paused", "provisioning", "partial-data", "gas-blocked", "gas-low"]);
const GAS_STATES = new Set(["unknown", "blocked", "low", "ok"]);
const HOLDING_METHODS = new Set(["wallet-native-v1", "wallet-known-erc20-v1", "sellable-lp-exit-v1", "owner-wide-venus-stored-net-v1", "none"]);
const PNL_COVERAGE = new Set(["full", "partial", "unsupported", "unavailable"]);
const BASIS_SOURCES = new Set(["owner-budget", "imported"]);
const EXCLUDED = new Set(["relay-and-gas", "wallet-residue", "closed-lineages", "prior-exits", "external-cashflows", "zero-basis-lineages"]);
const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const SIGNED = /^-?\d+$/u;
const UNSIGNED = /^\d+$/u;

function row(value: unknown): Row | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null; }
function exact(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function decimal(value: unknown, signed = false): boolean { return typeof value === "string" && (signed ? SIGNED : UNSIGNED).test(value); }
function decimalOrNull(value: unknown, signed = false): boolean { return value === null || decimal(value, signed); }
function addressOrNull(value: unknown): boolean { return value === null || typeof value === "string" && ADDRESS.test(value); }

function validCoverage(value: unknown): boolean {
  const item = row(value);
  if (item === null || !exact(item, ["state", "reasons"]) || typeof item["state"] !== "string" || !STATES.has(item["state"]) || !Array.isArray(item["reasons"]) || item["reasons"].length === 0) return false;
  if (!item["reasons"].every((reason) => typeof reason === "string" && REASONS.has(reason as AccountCoverageReason))) return false;
  const canonical = [...new Set(item["reasons"] as AccountCoverageReason[])].sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
  if (canonical.join(",") !== item["reasons"].join(",")) return false;
  const complete = item["state"] === "complete" || item["state"] === "empty";
  return complete ? item["reasons"].length === 1 && item["reasons"][0] === "none" : !item["reasons"].includes("none");
}

function validAsset(value: unknown): boolean {
  const asset = row(value);
  if (asset === null || !exact(asset, ["kind", "walletAddress", "tokenAddress", "symbol", "decimals", "balanceAtomic", "priceUsdMicros", "pricedAt", "valueUsdMicros", "status", "method"])) return false;
  if ((asset["kind"] !== "native" && asset["kind"] !== "erc20") || typeof asset["walletAddress"] !== "string" || !ADDRESS.test(asset["walletAddress"]) || !addressOrNull(asset["tokenAddress"])) return false;
  if (asset["symbol"] !== null && typeof asset["symbol"] !== "string" || asset["decimals"] !== null && (!integer(asset["decimals"]) || asset["decimals"] > 255)) return false;
  if (!decimalOrNull(asset["balanceAtomic"]) || !decimalOrNull(asset["priceUsdMicros"]) || !decimalOrNull(asset["valueUsdMicros"]) || asset["pricedAt"] !== null && !integer(asset["pricedAt"])) return false;
  if (!new Set(["priced", "zero", "unpriced", "unreadable"]).has(asset["status"] as string) || !new Set(["wallet-native-v1", "wallet-known-erc20-v1"]).has(asset["method"] as string)) return false;
  if (asset["kind"] === "native" && (asset["tokenAddress"] !== null || asset["method"] !== "wallet-native-v1") || asset["kind"] === "erc20" && (asset["tokenAddress"] === null || asset["method"] !== "wallet-known-erc20-v1")) return false;
  if (asset["status"] === "priced" && (asset["balanceAtomic"] === null || asset["priceUsdMicros"] === null || asset["valueUsdMicros"] === null)) return false;
  if (asset["status"] === "zero" && (asset["balanceAtomic"] !== "0" || asset["valueUsdMicros"] !== "0")) return false;
  if ((asset["status"] === "unpriced" || asset["status"] === "unreadable") && asset["valueUsdMicros"] !== null) return false;
  return asset["status"] !== "unreadable" || asset["balanceAtomic"] === null;
}

/**
 * AGENT-GAS-ATTENTION §3.1 — the per-agent gas block, or `null`.
 *
 * Validated as strictly as every other block on this view, and for the same
 * reason the rest of this file is: what reaches the browser here is a figure a
 * user acts on by sending BNB somewhere. A partially-formed gas block would
 * render a threshold nobody computed.
 */
function validGas(value: unknown): boolean {
  if (value === null) return true;
  const gas = row(value);
  if (gas === null || !exact(gas, ["state", "nativeWei", "nextMotionWei", "warnWei", "blockWei", "enforcement"])) return false;
  if (typeof gas["state"] !== "string" || !GAS_STATES.has(gas["state"])) return false;
  if (gas["enforcement"] !== "block" && gas["enforcement"] !== "warn-only") return false;
  if (!decimal(gas["nextMotionWei"]) || !decimal(gas["warnWei"]) || !decimal(gas["blockWei"])) return false;
  if (!decimalOrNull(gas["nativeWei"])) return false;
  // REVIEW FINDING 9 — POSITIVE and ORDERED, not merely numeric. A zero
  // threshold is a floor nobody computed; a stand-down line above the warning
  // line is a wallet the page would call healthy while the worker held it.
  const next = BigInt(gas["nextMotionWei"] as string);
  const warn = BigInt(gas["warnWei"] as string);
  const block = BigInt(gas["blockWei"] as string);
  if (next <= 0n || warn <= 0n || block <= 0n) return false;
  if (block > next || warn < next) return false;
  // A balance nobody read can only be `unknown`, and an `unknown` state can
  // carry no balance. Either way round, the two must agree.
  if ((gas["nativeWei"] === null) !== (gas["state"] === "unknown")) return false;
  // REVIEW 2 — the STATE must agree with the NUMBERS. A wallet holding zero,
  // declared `"ok"` against a positive floor, passed every check above.
  if (gas["nativeWei"] !== null) {
    const balance = BigInt(gas["nativeWei"] as string);
    const derived = balance < block ? "blocked" : balance < warn ? "low" : "ok";
    if (derived !== gas["state"]) return false;
  }
  return true;
}

function validAgent(value: unknown): boolean {
  const agent = row(value); const holdings = row(agent?.["holdings"]); const pnl = row(agent?.["pnl"]);
  if (agent === null || holdings === null || pnl === null || !exact(agent, ["id", "status", "httpRuntimeProfile", "walletAddress", "attention", "gas", "holdings", "pnl"]) || !validGas(agent["gas"])) return false;
  if (typeof agent["id"] !== "string" || typeof agent["status"] !== "string" || !STATUSES.has(agent["status"]) || typeof agent["httpRuntimeProfile"] !== "string" || !PROFILES.has(agent["httpRuntimeProfile"]) || typeof agent["walletAddress"] !== "string" || !ADDRESS.test(agent["walletAddress"]) || typeof agent["attention"] !== "string" || !ATTENTION.has(agent["attention"])) return false;
  if (!exact(holdings, ["method", "state", "reason", "valueUsdMicros", "venusReference", "held"]) || typeof holdings["method"] !== "string" || !HOLDING_METHODS.has(holdings["method"]) || typeof holdings["state"] !== "string" || !STATES.has(holdings["state"]) || typeof holdings["reason"] !== "string" || !REASONS.has(holdings["reason"] as AccountCoverageReason) || !decimalOrNull(holdings["valueUsdMicros"], true) || holdings["venusReference"] !== null && holdings["venusReference"] !== "owner-wide" || typeof holdings["held"] !== "boolean") return false;
  if ((holdings["state"] === "partial" || holdings["state"] === "unavailable") && holdings["valueUsdMicros"] !== null) return false;
  if (!exact(pnl, ["method", "coverage", "reason", "eligibleBasisNativeWei", "markNativeWei", "pnlNativeWei", "pnlUsdMicros", "pnlBps", "basisSources", "excluded"]) || (pnl["method"] !== "gross-lp-mark-plus-residue-to-declared-basis-v2" && pnl["method"] !== "none") || typeof pnl["coverage"] !== "string" || !PNL_COVERAGE.has(pnl["coverage"]) || typeof pnl["reason"] !== "string" || !REASONS.has(pnl["reason"] as AccountCoverageReason)) return false;
  if (!decimalOrNull(pnl["eligibleBasisNativeWei"]) || !decimalOrNull(pnl["markNativeWei"]) || !decimalOrNull(pnl["pnlNativeWei"], true) || !decimalOrNull(pnl["pnlUsdMicros"], true) || !decimalOrNull(pnl["pnlBps"], true)) return false;
  if (!Array.isArray(pnl["basisSources"]) || !pnl["basisSources"].every((source) => typeof source === "string" && BASIS_SOURCES.has(source)) || !Array.isArray(pnl["excluded"]) || !pnl["excluded"].every((entry) => typeof entry === "string" && EXCLUDED.has(entry))) return false;
  if (pnl["coverage"] !== "full" && [pnl["eligibleBasisNativeWei"], pnl["markNativeWei"], pnl["pnlNativeWei"], pnl["pnlUsdMicros"], pnl["pnlBps"]].some((field) => field !== null)) return false;
  if (pnl["coverage"] !== "full" && pnl["basisSources"].length !== 0) return false;
  const canonicalSources = [...new Set(pnl["basisSources"] as string[])].sort();
  if (canonicalSources.join(",") !== pnl["basisSources"].join(",")) return false;
  // AGENT-GAS-ATTENTION §4 — `...-v2` publishes ONE of two exclusion lists: the
  // full one when the residue could not be attributed (a shared wallet, an
  // unpriced leg), and the shorter one when it WAS counted. Both are pinned, in
  // order, so a plane that starts omitting an exclusion is still refused.
  const canonicalExcluded = ["relay-and-gas", "wallet-residue", "closed-lineages", "prior-exits", "external-cashflows", "zero-basis-lineages"];
  const residueCountedExcluded = ["relay-and-gas", "closed-lineages", "prior-exits", "external-cashflows", "zero-basis-lineages"];
  const excludedText = pnl["excluded"].join(",");
  if (pnl["method"] === "none" && (pnl["basisSources"].length !== 0 || pnl["excluded"].length !== 0)) return false;
  if (pnl["method"] === "gross-lp-mark-plus-residue-to-declared-basis-v2"
    && excludedText !== canonicalExcluded.join(",") && excludedText !== residueCountedExcluded.join(",")) return false;
  if (holdings["method"] === "owner-wide-venus-stored-net-v1" && holdings["venusReference"] !== "owner-wide" || holdings["method"] !== "owner-wide-venus-stored-net-v1" && holdings["venusReference"] !== null) return false;
  return true;
}

const CUSTODY_MODELS = new Set(["self-eoa", "passkey", "hd-derived"]);
/**
 * The KeyStore verdicts a DECLARED wallet entry may carry. `"no-matching-key"`
 * is in the vocabulary but never on a 200 — the plane refuses that request —
 * and accepting it here keeps the validator a mirror of the wire rather than a
 * second, divergent rule about what the plane may say.
 */
const PASSKEY_VERDICTS = new Set(["verified", "not-registered", "no-matching-key", "unreadable"]);

/**
 * A wallet entry is a DEPOSIT TARGET. `depositable` must be the literal `true`
 * the plane sends, so a shape that merely happens to carry an address cannot
 * pass for one.
 */
function validWallet(value: unknown): boolean {
  const wallet = row(value);
  // A DECLARED entry carries one extra field and an AGENTS entry must not: the
  // KeyStore verdict is an answer about a caller's claim, and a row the plane
  // wrote itself makes no such claim.
  const declared = wallet !== null && wallet["source"] === "declared";
  const keys = ["address", "custodyModel", "depositable", "source", "availableUsdMicros", "deployedUsdMicros", "deployedReason"];
  if (wallet === null || !exact(wallet, declared ? [...keys, "passkeyVerified"] : keys)) return false;
  if (declared && !PASSKEY_VERDICTS.has(wallet["passkeyVerified"] as string)) return false;
  if (typeof wallet["address"] !== "string" || !ADDRESS.test(wallet["address"])) return false;
  if (typeof wallet["custodyModel"] !== "string" || !CUSTODY_MODELS.has(wallet["custodyModel"]) || wallet["depositable"] !== true) return false;
  if (wallet["source"] !== "agents" && wallet["source"] !== "declared") return false;
  if (typeof wallet["deployedReason"] !== "string" || !REASONS.has(wallet["deployedReason"] as AccountCoverageReason)) return false;
  // A declared wallet is one the CLIENT named: the plane read its public
  // balances and owns no rows on it, so its deployed figure is zero BY ABSENCE
  // and must say so rather than passing for a measured zero.
  if (wallet["source"] === "declared" && (wallet["deployedUsdMicros"] !== "0" || wallet["deployedReason"] !== "declared")) return false;
  if (wallet["source"] === "agents" && wallet["deployedReason"] === "declared") return false;
  return decimalOrNull(wallet["availableUsdMicros"], true) && decimalOrNull(wallet["deployedUsdMicros"], true);
}

function validVenus(value: unknown): boolean {
  if (value === null) return true;
  const venus = row(value);
  return venus !== null && exact(venus, ["reference", "method", "observedAt", "supplyUsdMicros", "borrowUsdMicros", "netUsdMicros"])
    && venus["reference"] === "owner-wide" && venus["method"] === "owner-wide-venus-stored-net-v1" && integer(venus["observedAt"])
    && decimal(venus["supplyUsdMicros"]) && decimal(venus["borrowUsdMicros"]) && decimal(venus["netUsdMicros"], true);
}

export function accountPortfolioForOwner(value: unknown, owner: string): AccountPortfolio | null {
  const body = row(value); const data = row(body?.["data"]); const totals = row(data?.["totals"]); const coverage = row(data?.["coverage"]);
  if (body === null || !exact(body, ["data"]) || data === null || totals === null || coverage === null || !exact(data, ["generatedAt", "asOf", "ownerAddress", "wallets", "assets", "venus", "totals", "agents", "coverage"])) return null;
  if (!integer(data["generatedAt"]) || data["asOf"] !== null && !integer(data["asOf"]) || typeof data["ownerAddress"] !== "string" || !ADDRESS.test(data["ownerAddress"]) || data["ownerAddress"] !== owner.toLowerCase()) return null;
  if (!Array.isArray(data["wallets"]) || !data["wallets"].every(validWallet) || !Array.isArray(data["assets"]) || !data["assets"].every(validAsset) || !Array.isArray(data["agents"]) || !data["agents"].every(validAgent) || !validVenus(data["venus"])) return null;
  if (!exact(totals, ["walletUsdMicros", "deployedUsdMicros", "totalUsdMicros", "grossLpPnlUsdMicros", "grossLpPnlBps", "eligibleLpBasisNativeWei"])) return null;
  if (!decimalOrNull(totals["walletUsdMicros"], true) || !decimalOrNull(totals["deployedUsdMicros"], true) || !decimalOrNull(totals["totalUsdMicros"], true) || !decimalOrNull(totals["grossLpPnlUsdMicros"], true) || !decimalOrNull(totals["grossLpPnlBps"], true) || !decimalOrNull(totals["eligibleLpBasisNativeWei"])) return null;
  if (!exact(coverage, ["universe", "wallet", "deployed", "total", "pnl", "truncated"]) || coverage["universe"] !== "known-assets" || !validCoverage(coverage["wallet"]) || !validCoverage(coverage["deployed"]) || !validCoverage(coverage["total"]) || !validCoverage(coverage["pnl"])) return null;
  const truncated = row(coverage["truncated"]);
  if (truncated === null || !exact(truncated, ["agents", "wallets", "tokens", "walletTokenPairs", "positions"]) || !Object.values(truncated).every((flag) => typeof flag === "boolean")) return null;
  const totalCoverage = row(coverage["total"]); const pnlCoverage = row(coverage["pnl"]);
  const walletCoverage = row(coverage["wallet"]); const deployedCoverage = row(coverage["deployed"]);
  if (walletCoverage?.["state"] !== "complete" && walletCoverage?.["state"] !== "empty" && totals["walletUsdMicros"] !== null) return null;
  if (deployedCoverage?.["state"] !== "complete" && deployedCoverage?.["state"] !== "empty" && totals["deployedUsdMicros"] !== null) return null;
  if (totalCoverage?.["state"] !== "complete" && totalCoverage?.["state"] !== "empty" && totals["totalUsdMicros"] !== null) return null;
  if (pnlCoverage?.["state"] !== "complete" && [totals["grossLpPnlUsdMicros"], totals["grossLpPnlBps"], totals["eligibleLpBasisNativeWei"]].some((field) => field !== null)) return null;
  return data as unknown as AccountPortfolio;
}

export function displayablePnlUsdMicros(agent: AccountPortfolio["agents"][number]): string | null { return agent.pnl.coverage === "full" ? agent.pnl.pnlUsdMicros : null; }
export function signedReadFallbackRequired(status: number): boolean { return status === 404; }
export function currentAccountRequest(generation: number, currentGeneration: number, requestedOwner: string | undefined, currentOwner: string | undefined): boolean { return generation === currentGeneration && requestedOwner?.toLowerCase() === currentOwner?.toLowerCase(); }

/**
 * The liquid NATIVE balance of one wallet, in wei — the only figure a withdrawal
 * may be sized against.
 *
 * NOT `wallets[].availableUsdMicros`: that is a USD mark over native PLUS known
 * ERC-20s, so sizing a BNB withdrawal from it would offer to send tokens the
 * wallet does not hold as BNB. `null` when the row is missing or unreadable,
 * which the UI renders as "balance unavailable" and refuses to withdraw on.
 */
export function nativeBalanceWei(portfolio: AccountPortfolio, walletAddress: string): bigint | null {
  const row = portfolio.assets.find(
    (asset) =>
      asset.kind === "native" &&
      asset.walletAddress.toLowerCase() === walletAddress.toLowerCase(),
  );
  if (row === undefined || row.status === "unreadable") return null;
  if (row.balanceAtomic === null || !/^\d+$/u.test(row.balanceAtomic)) return null;
  return BigInt(row.balanceAtomic);
}

/**
 * Whether Remove has already taken this agent out of service.
 *
 * `/account/portfolio` never deletes an agent row — the record is the audit
 * trail of a session that once held on-chain authority — so the Account list
 * has to decide for itself what "still mine" means. `revoked` is the state the
 * owner-signed `/revoke` writes, `retired` the state expiry writes; neither can
 * open, rotate or hold anything, and the portfolio's own totals already exclude
 * both (`isLive` in `src/account/portfolio.ts`). They are hidden by default and
 * reachable behind the list's own disclosure — hidden, never dropped, because
 * a revoked row whose on-chain revoke is still unsigned is exactly the row an
 * owner may need to open again.
 */
export function isRemovedAgent(agent: AccountPortfolio["agents"][number]): boolean {
  return agent.status === "revoked" || agent.status === "retired";
}

/**
 * The balance of one known ERC-20 in one wallet, in its atomic unit, from the
 * same asset rows `nativeBalanceWei` reads. `null` when the plane did not list
 * the token for this wallet or could not read it — the caller says so instead
 * of sizing on zero.
 */
export function erc20BalanceAtomic(portfolio: AccountPortfolio, walletAddress: string, tokenAddress: string): bigint | null {
  const row = portfolio.assets.find(
    (asset) =>
      asset.kind === "erc20" &&
      asset.walletAddress.toLowerCase() === walletAddress.toLowerCase() &&
      asset.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase(),
  );
  if (row === undefined || row.status === "unreadable") return null;
  if (row.balanceAtomic === null || !/^\d+$/u.test(row.balanceAtomic)) return null;
  return BigInt(row.balanceAtomic);
}

export type WithdrawableToken = {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly balanceAtomic: bigint;
};

/**
 * Every known ERC-20 this wallet actually holds, in the plane's own asset rows.
 *
 * The universe is the plane's: tokens named by an agent's session spend caps
 * plus the declared-wallet list. A revoked agent keeps its row and its caps, so
 * a token stranded by that agent's last exit stays visible after Remove — which
 * is exactly when the owner needs to move it. Rows the plane could not read, or
 * whose symbol/decimals it does not know, are dropped rather than shown with a
 * guess: an amount field cannot be checked against a balance nobody read.
 */
export function withdrawableTokens(portfolio: AccountPortfolio, walletAddress: string): readonly WithdrawableToken[] {
  return portfolio.assets.flatMap((asset) => {
    if (asset.kind !== "erc20" || asset.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) return [];
    if (asset.status === "unreadable" || asset.tokenAddress === null || asset.symbol === null) return [];
    if (asset.decimals === null || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) return [];
    if (asset.balanceAtomic === null || !/^\d+$/u.test(asset.balanceAtomic)) return [];
    const balanceAtomic = BigInt(asset.balanceAtomic);
    if (balanceAtomic <= 0n) return [];
    return [{ address: asset.tokenAddress, symbol: asset.symbol, decimals: asset.decimals, balanceAtomic }];
  });
}
