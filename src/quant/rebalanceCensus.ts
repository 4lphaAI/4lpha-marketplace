/** Deterministic, read-only shared-wallet migration census. */
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import type { QuantActionRow, QuantJobRow } from "../store/quantJobs.js";
import type { QuantWalletClaim } from "../store/quantWalletClaims.js";
import { rebalanceCanonicalEncode } from "./rebalanceCanonical.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow, QuantRebalanceCensus } from "./rebalanceTypes.js";

function digest(value: unknown): Hex { return keccak256(stringToBytes(rebalanceCanonicalEncode(value))); }
function textHash(value: string): Hex { return keccak256(stringToBytes(value)); }
function admitted(status: string, admittedAt: number | null): boolean { return admittedAt !== null || status === "admitted"; }

export type QuantWalletCensusInput = Readonly<{
  generatedAtMs: number;
  migrationInstalled: boolean;
  gridJobs: readonly QuantJobRow[];
  gridActions: readonly QuantActionRow[];
  rebalanceJobs: readonly QuantRebalanceJobRow[];
  rebalanceActions: readonly QuantRebalanceActionRow[];
  claims: readonly QuantWalletClaim[];
  receiptOwnership?: readonly { readonly wallet: Address; readonly journalKey: string }[];
}>;

type CensusJob = QuantRebalanceCensus["groups"][number]["jobs"][number];

function claimForWallet(claims: readonly QuantWalletClaim[], wallet: Address): QuantWalletClaim | null {
  const key = wallet.toLowerCase();
  return claims.find((claim) => claim.wallet.toLowerCase() === key) ?? null;
}

function actionSetDigest(actions: readonly unknown[]): Hex {
  const ordered = [...actions].sort((left, right) => {
    const a = typeof left === "object" && left !== null ? left as Record<string, unknown> : {};
    const b = typeof right === "object" && right !== null ? right as Record<string, unknown> : {};
    return String(a["actionId"] ?? a["journalKey"] ?? "").localeCompare(String(b["actionId"] ?? b["journalKey"] ?? ""));
  });
  return digest(ordered);
}

export function buildQuantWalletCensus(input: QuantWalletCensusInput): QuantRebalanceCensus {
  if (!Number.isSafeInteger(input.generatedAtMs) || input.generatedAtMs < 0) throw new Error("census-time-invalid");
  const groups = new Map<string, { wallet: Address; jobs: CensusJob[] }>();
  const add = (wallet: Address, row: CensusJob): void => {
    const key = wallet.toLowerCase();
    const group = groups.get(key) ?? { wallet, jobs: [] };
    group.jobs.push(row); groups.set(key, group);
  };
  const ownedCount = (wallet: Address, journalKeys: readonly string[]): number => {
    const keys = new Set(journalKeys);
    return (input.receiptOwnership ?? []).filter((owner) => owner.wallet.toLowerCase() === wallet.toLowerCase()
      && keys.has(owner.journalKey)).length;
  };

  for (const job of input.gridJobs) {
    const actions = input.gridActions.filter((action) => action.quantJobId === job.quantJobId);
    const claim = claimForWallet(input.claims, job.tradingWallet);
    add(job.tradingWallet, {
      strategyKind: "grid", jobId: job.quantJobId, status: job.status, rowVersion: job.rowVersion,
      admitted: admitted(job.status, job.admittedAtMs),
      actionStates: actions.map((action) => action.state).sort(),
      actionSetDigest: actionSetDigest(actions.map((action) => ({
        journalKey: action.journalKey, levelIndex: action.levelIndex, actionSeq: action.actionSeq,
        side: action.side, state: action.state, amountInWei: action.amountInWei, minOutWei: action.minOutWei,
        quoteOutWei: action.quoteOutWei, quoteBlock: action.quoteBlock, deadlineSec: action.deadlineSec,
        callsDigest: textHash(action.callsJson), txHash: action.txHash, fillInWei: action.fillInWei, fillOutWei: action.fillOutWei,
        rowVersion: action.rowVersion,
      }))),
      sessionExpirySec: job.sessionExpiry, revokedAtMs: job.revokedAtMs,
      claimGeneration: claim?.mode === "active" && claim.strategyKind === "grid" && claim.jobId === job.quantJobId
        ? claim.generation : null,
      accountingDigest: digest({ state: job.accountingState, epoch: job.accountingEpoch, revision: job.accountingRev }),
      receiptOwnershipCount: ownedCount(job.tradingWallet, actions.map((action) => action.journalKey)),
    });
  }

  for (const job of input.rebalanceJobs) {
    const actions = input.rebalanceActions.filter((action) => action.jobId === job.jobId);
    const claim = claimForWallet(input.claims, job.tradingWallet);
    add(job.tradingWallet, {
      strategyKind: "rebalance", jobId: job.jobId, status: job.status, rowVersion: job.rowVersion,
      admitted: admitted(job.status, job.admittedAtMs),
      actionStates: actions.map((action) => action.state).sort(),
      actionSetDigest: actionSetDigest(actions.map((action) => ({
        actionId: action.actionId, checkId: action.checkId, sequence: action.sequence,
        state: action.state, side: action.side, asset: action.asset, tokenIn: action.tokenIn.toLowerCase(),
        tokenOut: action.tokenOut.toLowerCase(), path: action.path.map((token) => token.toLowerCase()),
        pairAddresses: action.pairAddresses.map((pair) => pair.toLowerCase()), amountInWei: action.amountInWei,
        minOutWei: action.minOutWei, quoteOutWei: action.quoteOutWei, deadlineSec: action.deadlineSec,
        callsDigest: action.callsDigest, txHash: action.txHash, fillInWei: action.fillInWei,
        fillOutWei: action.fillOutWei, proofDigest: action.proofDigest, rowVersion: action.rowVersion,
      }))),
      sessionExpirySec: job.sessionExpirySec, revokedAtMs: job.revokedAtMs,
      claimGeneration: job.claimGeneration ?? (claim?.mode === "active" && claim.strategyKind === "rebalance" && claim.jobId === job.jobId
        ? claim.generation : null),
      accountingDigest: digest({ managed: job.managed, costBasis: job.costBasis,
        revision: job.accountingRev, externalActivity: job.externalActivity }),
      receiptOwnershipCount: ownedCount(job.tradingWallet, actions.map((action) => action.journalKey)),
    });
  }

  const orderedGroups = [...groups.values()].map((group) => ({
    wallet: group.wallet,
    jobs: group.jobs.sort((a, b) => a.strategyKind.localeCompare(b.strategyKind) || a.jobId.localeCompare(b.jobId)),
    receiptOwnershipCount: group.jobs.reduce((sum, job) => sum + job.receiptOwnershipCount, 0),
    disposition: group.jobs.filter((job) => job.admitted).length > 1
      ? "operator-disposition-required" as const : "clear" as const,
  })).sort((a, b) => a.wallet.toLowerCase().localeCompare(b.wallet.toLowerCase()));
  const digestValue = digest({
    version: "quant-wallet-census:1", generatedAtMs: input.generatedAtMs,
    migrationInstalled: input.migrationInstalled,
    groups: orderedGroups.map((group) => ({
      wallet: group.wallet.toLowerCase(), disposition: group.disposition,
      receiptOwnershipCount: group.receiptOwnershipCount,
      jobs: group.jobs,
    })),
  });
  return {
    generatedAtMs: input.generatedAtMs, migrationInstalled: input.migrationInstalled,
    groups: orderedGroups, digest: digestValue,
  };
}
