import { describe, expect, it } from "vitest";
import { freshFundingGate, hireResumeStep, type HireFunding, type HireSessionView } from "./hire-state";

const funding: HireFunding = { version: 1, observedAtSec: 100, registrationFeeWei: "2", registrations: 2, relayGasHeadroomWei: "3", requiredWei: "7", balanceWei: "7" };
const view = (missing: HireSessionView["missing"]): HireSessionView => ({ status: "provisioning", missing });

describe("hire reload matrix", () => {
  it("resumes S1, grant, poll, arm and terminal states without automatic re-grant", () => {
    expect(hireResumeStep(null)).toBe("s1");
    expect(hireResumeStep(view([]))).toBe("fund-and-grant");
    expect(hireResumeStep(view(["account-key", "keystore-id"]))).toBe("fund-and-grant");
    expect(hireResumeStep(view(["account-key", "keystore-id", "wallet-not-registered"]))).toBe("fund-and-grant");
    expect(hireResumeStep({ ...view(["account-key", "keystore-id"]), grantAttempt: {
      version: 1, attemptId: `0x${"11".repeat(32)}`, startedAtSec: 100,
    } })).toBe("converge");
    expect(hireResumeStep(view(["account-key"]))).toBe("poll");
    expect(hireResumeStep({ ...view(["account-key", "keystore-id"]), cancelRequested: true })).toBe("poll");
    expect(hireResumeStep({ status: "armed" })).toBe("arm");
    expect(hireResumeStep(view(["permissions-differ"]))).toBe("terminal");
  });
});

describe("fresh S2 funding gate", () => {
  it("accepts only a <=30-second readable, sufficient snapshot", () => {
    expect(freshFundingGate(funding, 130)).toEqual({ ok: true });
    expect(freshFundingGate(funding, 131)).toEqual({ ok: false, reason: "stale" });
    expect(freshFundingGate({ ...funding, balanceWei: null }, 100)).toEqual({ ok: false, reason: "unreadable" });
    expect(freshFundingGate({ ...funding, balanceWei: "6" }, 100)).toEqual({ ok: false, reason: "short" });
  });
});
