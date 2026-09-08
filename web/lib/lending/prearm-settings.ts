import { paramsHash } from "@/lib/exec/owner-action";
import type { LendingArmRecovery, LendingArmValues } from "./arm-recovery";
import { formatAtomicAmount, parseUsd, usdToUsdtWei } from "./form";

export function sameLendingArmValues(left: LendingArmValues, right: LendingArmValues): boolean {
  return left.budgetWei === right.budgetWei && left.reserveBps === right.reserveBps
    && paramsHash("lendingSettings", left.settings) === paramsHash("lendingSettings", right.settings);
}

export function lendingUsdtCapRefusal(values: LendingArmValues, usdt: string, capWei: string, decimals: number): string | null {
  const ceiling = values.settings.maxPerAction.find(cap => cap.token?.toLowerCase() === usdt.toLowerCase());
  return ceiling !== undefined && BigInt(ceiling.maxWei) > BigInt(capWei)
    ? `Saved USDT max repay exceeds this session's ${formatAtomicAmount(capWei, decimals, decimals)} USDT cap. Enter a lower Max repay per event and save it before placing the reserve.`
    : null;
}

/** A settings save never arms. Only a verified owner read may replace the arm cache. */
export async function saveLendingUsdtRepay(input: {
  readonly agentId: string;
  readonly amountUsd: string;
  readonly usdt: string;
  readonly decimals: number;
  readonly readCurrent: () => Promise<LendingArmRecovery>;
  readonly signEnvelope: (action: string, agentId: string, params: unknown) => Promise<unknown>;
  readonly check: () => void;
  readonly fetcher?: typeof fetch;
}): Promise<Extract<LendingArmRecovery, { kind: "recovered" }>> {
  input.check();
  const usd = parseUsd(input.amountUsd);
  const amount = usd === null ? null : usdToUsdtWei(usd, input.decimals);
  if (amount === null) throw new Error("Enter a positive USDT max repay amount.");
  const before = await input.readCurrent();
  input.check();
  if (before.kind !== "recovered") throw new Error(before.reason);
  if (amount > BigInt(before.reserveCapWei)) {
    throw new Error(`Max repay must be at most ${formatAtomicAmount(before.reserveCapWei, input.decimals, input.decimals)} USDT for this session.`);
  }
  if (!before.values.settings.maxPerAction.some(cap => cap.token?.toLowerCase() === input.usdt.toLowerCase())) {
    throw new Error("This guard has no USDT repay ceiling to update. Its BNB settings are unchanged.");
  }
  const settings = {
    ...before.values.settings,
    maxPerAction: before.values.settings.maxPerAction.map(cap => cap.token?.toLowerCase() === input.usdt.toLowerCase()
      ? { ...cap, maxWei: amount.toString(10) } : cap),
  };
  const envelope = await input.signEnvelope("lendingSettings", input.agentId, settings);
  input.check();
  const response = await (input.fetcher ?? fetch)(`/api/agents/${encodeURIComponent(input.agentId)}/lending/settings`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
  });
  input.check();
  if (!response.ok) {
    const body = await response.json() as { error?: { message?: string; code?: string } };
    throw new Error(body.error?.message ?? body.error?.code ?? `Settings save failed (HTTP ${response.status}).`);
  }
  const after = await input.readCurrent();
  input.check();
  if (after.kind !== "recovered") throw new Error(after.reason);
  if (!sameLendingArmValues(after.values, { ...before.values, settings }) || after.reserveCapWei !== before.reserveCapWei) {
    throw new Error("The saved settings could not be confirmed. Read the current settings and save again; no reserve was placed.");
  }
  return after;
}
