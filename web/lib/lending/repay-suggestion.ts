import type { LendingGuardableView } from "@/lib/exec/lending-types";

/** A form suggestion only: never widens a session cap or changes signed settings. */
export function suggestLendingRepay(input: {
  readonly account: string;
  readonly view: LendingGuardableView | null;
  readonly loading: boolean;
  readonly capitalWei: bigint;
  readonly priceMicros: bigint | null;
}): string | null {
  if (input.loading || input.view === null || !input.view.guardable
    || input.account.toLowerCase() !== input.view.account.toLowerCase()
    || input.capitalWei <= 0n || input.priceMicros === null || input.priceMicros <= 0n) return null;
  try {
    let debtUsd18 = 0n;
    for (const debt of input.view.debts) {
      if (!debt.supported || BigInt(debt.borrowWei) <= 0n) continue;
      const value = BigInt(debt.debtValueMantissa);
      if (value < 0n) return null;
      debtUsd18 += value;
    }
    const capitalUsd18 = input.capitalWei * input.priceMicros / 1_000_000n;
    const cents = (debtUsd18 < capitalUsd18 ? debtUsd18 : capitalUsd18) / 10n ** 16n;
    if (cents <= 0n) return null;
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  } catch { return null; }
}
