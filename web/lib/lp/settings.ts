import {
  checkBoundedText,
  MAX_INSTRUCTIONS_ENCODED_BYTES,
  tradeModelId,
  validateSkillMarkdown,
} from "@/lib/trade";

export const LP_DEFAULT_HARVEST_MIN_FEES_WEI = "2000000000000000";

export type LpSettingsInput = {
  readonly compoundOn: boolean;
  readonly takeProfitPct: number;
  readonly stopLossPct: number;
  readonly budgetWei: bigint;
  readonly minFees: number;
  readonly rotateMinHoldMinutes?: number;
  readonly rotateMode?: "swapped" | "swapless";
  readonly minAprBps?: number;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly instructions?: string;
  readonly skillFile?: { readonly name: string; readonly text: string } | null;
};

function requireIntInRange(value: number, low: number, high: number, label: string): number {
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new Error(`${label} must be a whole number between ${low} and ${high}.`);
  }
  return value;
}

function harvestMinFeesWei(budgetWei: bigint, pct: number): string {
  const wholePct = requireIntInRange(pct, 1, 100, "Minimum fees to compound");
  const wei = (budgetWei * BigInt(wholePct)) / 100n;
  if (wei <= 0n) {
    throw new Error("The minimum fees to compound must be a positive amount.");
  }
  return wei.toString(10);
}

export function buildLpSettings(input: LpSettingsInput): Record<string, unknown> {
  const primaryModel = tradeModelId(input.primaryModel);
  const fallbackModel = tradeModelId(input.fallbackModel);
  if (primaryModel === fallbackModel) {
    throw new Error("Primary and fallback models must differ.");
  }

  const instructions = String(input.instructions ?? "");
  const boundedInstructions = checkBoundedText(
    instructions,
    MAX_INSTRUCTIONS_ENCODED_BYTES,
    "Instructions",
  );
  if (!boundedInstructions.ok) throw new Error(boundedInstructions.message);

  const skillFile = input.skillFile ?? null;
  if (skillFile !== null) {
    const checked = validateSkillMarkdown(skillFile.name, skillFile.text);
    if (!checked.ok) throw new Error(checked.message);
  }

  const brain = {
    primaryModel,
    fallbackModel,
    instructions,
    skillMarkdown: skillFile?.text ?? "",
  };

  return {
    autoRotate: true,
    autoHarvest: input.compoundOn,
    rotateBandBps: 0,
    rotateMinHoldMinutes: requireIntInRange(
      input.rotateMinHoldMinutes ?? 5,
      3,
      525_600,
      "Rebalance cooldown (minutes)",
    ),
    harvestMinFeesWei: harvestMinFeesWei(input.budgetWei, input.minFees),
    stopLossPct: requireIntInRange(input.stopLossPct, 0, 90, "Stop loss"),
    takeProfitPct: requireIntInRange(input.takeProfitPct, 0, 500, "Take profit"),
    maxExitSequencesPerDay: 4,
    // The cooldown the owner chose is the real constraint (2026-09-06): the
    // exit-spacing gate is agent-wide and its anchor includes the OPEN, so a
    // hidden 30 here blocked every first rotate for 30 minutes after arming.
    // The plane validates 5..1440.
    minMinutesBetweenExits: Math.min(1_440, Math.max(5, Math.round(input.rotateMinHoldMinutes ?? 5))),
    brainEnabled: true,
    brain,
    stakingEnabled: false,
    accumulateMode: "compound",
    minAprBps: requireIntInRange(input.minAprBps ?? 0, 0, 1_000_000, "Minimum APR (bps)"),
    exitToQuote: true,
    ...(input.rotateMode === undefined || input.rotateMode === "swapped"
      ? {}
      : { rotateMode: input.rotateMode }),
  };
}
