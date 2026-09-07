import type { HireFunding } from "./hire-state";

/**
 * THE deposit a hire needs, computed rather than asked for.
 *
 * The deposit modal used to be a free-form field, so an owner could type any
 * amount and then sit in the funding wait with no idea how short they were.
 * Everything the number depends on is already in the hire preview, so the
 * flow fills it in: the grid's own budget (what the arm wraps and mints), the
 * KeyStore registration fee and the relay gas headroom the plane estimated for
 * the grant, a small pad for the arm's own submission, AND the plane's own
 * daily native reserve (`sizing.reserves.totalWei`: exits, protects, flips and
 * shift motions for one day, each priced in relay fee units) — minus whatever
 * the agent wallet already holds that is genuinely free. Rounded UP to four
 * places so a truncated figure never lands one wei short of the gate it was
 * computed for.
 *
 * GRID-GAS-RESERVE W1 (2026-09-04). Two things this formula got wrong, live:
 *
 *  1. It carried NO operating reserve. The pad (3 fee units) is about one arm,
 *     so the very first shift after the arm had nothing to pay the relay with.
 *  2. It credited the wallet's ENTIRE balance as free money. Wallet B is one
 *     passkey EOA shared by every agent the owner hires; the 0.0015 BNB that
 *     `grid-agent-01-5` had left for its shifts was subtracted from `btcb`'s
 *     deposit, `btcb`'s arm consumed it, and both agents were left with
 *     0.000098693 BNB — less than one metered shift. Native BNB in a wallet
 *     that already carries a live agent is that agent's gas pot by
 *     construction (principal sits in NFTs and WBNB), so when the wallet is
 *     `sharedWithLiveAgents` NONE of its balance is credited. Over-funding is
 *     the safe direction, and Account withdraw exists.
 *
 * `capDayWei` is deliberately NOT here: it is the session's daily spend
 * ceiling, not money that has to exist in the wallet.
 */
export type HireSizingForDeposit = {
  readonly openNativeBudgetWei: string;
  readonly relayFeePerSubmitWei: string;
  /** The plane's daily native reserve; ABSENT (older preview) counts as zero. */
  readonly reserves?: { readonly totalWei: string } | undefined;
};

/** Submissions the arm may need on top of the grant: the mint plus a re-submit. */
export const ARM_GAS_SUBMISSION_PAD = 3n;

const DECIMAL = /^\d+$/u;

function wei(value: string, label: string): bigint {
  if (!DECIMAL.test(value)) throw new Error(`${label} is not a wei amount.`);
  return BigInt(value);
}

export function requiredDepositWei(input: {
  readonly sizing: HireSizingForDeposit;
  readonly funding: HireFunding;
  /**
   * Whether ANOTHER agent (provisioning, armed or paused) lives on this wallet.
   * `true` credits none of the balance. Callers that cannot tell MUST pass
   * `true`: an unknown neighbour is a neighbour.
   */
  readonly sharedWithLiveAgents: boolean;
}): { readonly totalWei: bigint; readonly creditedWei: bigint; readonly shortfallWei: bigint } {
  const budget = wei(input.sizing.openNativeBudgetWei, "openNativeBudgetWei");
  const relayFee = wei(input.sizing.relayFeePerSubmitWei, "relayFeePerSubmitWei");
  const reserve = input.sizing.reserves === undefined ? 0n : wei(input.sizing.reserves.totalWei, "reserves.totalWei");
  const registration = wei(input.funding.registrationFeeWei, "registrationFeeWei") * BigInt(input.funding.registrations);
  const headroom = wei(input.funding.relayGasHeadroomWei, "relayGasHeadroomWei");
  const totalWei = budget + registration + headroom + relayFee * ARM_GAS_SUBMISSION_PAD + reserve;
  const balance = input.funding.balanceWei === null ? 0n : wei(input.funding.balanceWei, "balanceWei");
  const creditedWei = input.sharedWithLiveAgents ? 0n : balance;
  const shortfallWei = totalWei > creditedWei ? totalWei - creditedWei : 0n;
  return { totalWei, creditedWei, shortfallWei };
}

/** Trading wallets are exclusive, so their readable balance is safe credit. */
export function requiredTradeDepositWei(input: {
  readonly capDayWei: string;
  readonly funding: HireFunding;
}): { readonly depositTargetWei: bigint; readonly depositCreditedWei: bigint; readonly depositShortfallWei: bigint } {
  const capital = wei(input.capDayWei, "capDayWei");
  const registration = wei(input.funding.registrationFeeWei, "registrationFeeWei")
    * BigInt(input.funding.registrations);
  const headroom = wei(input.funding.relayGasHeadroomWei, "relayGasHeadroomWei");
  const depositTargetWei = capital + registration + headroom;
  const depositCreditedWei = input.funding.balanceWei === null ? 0n : wei(input.funding.balanceWei, "balanceWei");
  return {
    depositTargetWei,
    depositCreditedWei,
    depositShortfallWei: depositTargetWei > depositCreditedWei ? depositTargetWei - depositCreditedWei : 0n,
  };
}

/** Wei → BNB with four places, rounded UP, as the deposit field shows it. */
export function depositAmountBnb(shortfallWei: bigint): string {
  const unit = 10n ** 14n;
  const units = (shortfallWei + unit - 1n) / unit;
  const whole = units / 10_000n;
  const fraction = (units % 10_000n).toString(10).padStart(4, "0");
  return `${whole}.${fraction}`;
}

/** The wei amount the wallet is asked to send: the rounded-up figure, exactly. */
export function depositAmountWei(shortfallWei: bigint): bigint {
  const unit = 10n ** 14n;
  return ((shortfallWei + unit - 1n) / unit) * unit;
}

/**
 * Whether any OTHER agent on the same wallet is live. Rows the plane lists with
 * `status` and `walletAddress`; anything else (an older list shape) is treated
 * as a neighbour, because the safe reading of "cannot tell" is "shared".
 */
export function walletSharedWithLiveAgents(input: {
  readonly agents: readonly { readonly id?: unknown; readonly status?: unknown; readonly walletAddress?: unknown }[];
  readonly walletAddress: string;
  readonly excludingId: string;
}): boolean {
  const wallet = input.walletAddress.toLowerCase();
  for (const agent of input.agents) {
    if (agent.id === input.excludingId) continue;
    if (typeof agent.status !== "string" || typeof agent.walletAddress !== "string") return true;
    if (agent.walletAddress.toLowerCase() !== wallet) continue;
    if (agent.status === "provisioning" || agent.status === "armed" || agent.status === "paused") return true;
  }
  return false;
}
