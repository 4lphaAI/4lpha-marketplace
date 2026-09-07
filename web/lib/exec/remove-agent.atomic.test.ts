import { describe, it, expect } from "vitest";
import { lpStepLabel, lpSequenceLabel, removeBlockerOf } from "./remove-agent";
const sequence = { sequenceId: "s", kind: "rotate", state: "held", recoveryState: "rotate-ambiguous", steps: [{ decisionId: "lp:s:0", kind: "rotate-atomic", state: "UNKNOWN" }] };
describe("atomic rotate labels and recovery door", () => {
  it("labels one transaction and the unconfirmed hold exactly", () => {
    expect(lpStepLabel("rotate-atomic")).toBe("Rotate (one transaction)");
    expect(lpSequenceLabel(sequence)).toBe("Rotate submitted; outcome unconfirmed");
    expect(lpSequenceLabel({ ...sequence, state: "completed", recoveryState: "none" })).toBe("Rotate (one transaction) · completed");
  });
  it("offers declared abandon for atomic history and no resolver or abandon for legacy UNKNOWN", () => {
    expect(removeBlockerOf(sequence)).toMatchObject({ abandonable: true, resolvableDecisionId: null });
    expect(removeBlockerOf({ ...sequence, recoveryState: "pending-mint", steps: [{ decisionId: "lp:s:0", kind: "zap-out", state: "UNKNOWN" }] })).toMatchObject({ abandonable: false, resolvableDecisionId: null });
  });
});
