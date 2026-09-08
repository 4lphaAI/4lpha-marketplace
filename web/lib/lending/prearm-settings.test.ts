import { describe, expect, it, vi } from "vitest";
import { paramsHash } from "@/lib/exec/owner-action";
import type { LendingArmRecovery } from "./arm-recovery";
import { saveLendingUsdtRepay } from "./prearm-settings";

const USDT = "0x55d398326f99059fF775485246999027B3197955";
type Recovered = Extract<LendingArmRecovery, { kind: "recovered" }>;
function recovered(amount = "240000000000000000000"): Recovered {
  const settings = {
    triggerHf: "1200000000000000000", targetHf: "1500000000000000000",
    maxPerAction: [{ token: USDT, maxWei: amount }, { token: null, maxWei: "1000000000000000" }],
    minSecondsBetweenActions: 300, rescueReserveCount: 6, notifyOnlyBelowHf: "1100000000000000000",
  };
  return { kind: "recovered", guardStatus: "provisioning-guard", reserveCapWei: "27576869756323761389", digest: paramsHash("lendingSettings", settings), values: { settings, budgetWei: "20000000000000000", reserveBps: 2000 } };
}
function setup(amountUsd = "12") {
  const before = recovered();
  const after = recovered("12000000000000000000");
  const readCurrent = vi.fn<() => Promise<LendingArmRecovery>>().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  const signEnvelope = vi.fn(async (action: string, agentId: string, params: unknown) => ({ action, agentId, params }));
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { replayed: true } }), { status: 200 }));
  const input = { agentId: "lending-agent-01", amountUsd, usdt: USDT, decimals: 18, readCurrent, signEnvelope, fetcher, check: vi.fn() };
  return { input, before, after };
}

describe("explicit pre-arm USDT settings save", () => {
  it("changes only USDT, requires authoritative read-back even for replay, and never arms", async () => {
    const { input, before, after } = setup();
    expect(await saveLendingUsdtRepay(input)).toEqual(after);
    expect(input.signEnvelope).toHaveBeenCalledExactlyOnceWith("lendingSettings", input.agentId, after.values.settings);
    expect(after.values.settings.maxPerAction[1]).toEqual(before.values.settings.maxPerAction[1]);
    expect(after.values.settings).toMatchObject({ notifyOnlyBelowHf: "1100000000000000000" });
    expect(input.readCurrent).toHaveBeenCalledTimes(2);
    expect(input.fetcher.mock.calls.map(([url]) => String(url))).toEqual(["/api/agents/lending-agent-01/lending/settings"]);
  });
  it.each(["0", "-1", "", "NaN", "240", "27.576870"])("rejects invalid or over-cap amount %s before signing", async amount => {
    const { input } = setup(amount);
    await expect(saveLendingUsdtRepay(input)).rejects.toThrow();
    expect(input.signEnvelope).not.toHaveBeenCalled();
    expect(input.fetcher).not.toHaveBeenCalled();
  });
  it("refuses a BNB-only guard without inventing USDT authority", async () => {
    const { input, before } = setup();
    input.readCurrent.mockReset().mockResolvedValue({ ...before, values: { ...before.values, settings: { ...before.values.settings, maxPerAction: [before.values.settings.maxPerAction[1]!] } } });
    await expect(saveLendingUsdtRepay(input)).rejects.toThrow("no USDT repay ceiling");
    expect(input.signEnvelope).not.toHaveBeenCalled();
  });
  it.each<Exclude<LendingArmRecovery, { kind: "recovered" }>>([
    { kind: "refused", reason: "untrusted digest" },
    { kind: "past-arm", guardStatus: "held", reason: "held" },
  ])("refuses an unavailable or ineligible current view", async result => {
    const { input } = setup();
    input.readCurrent.mockReset().mockResolvedValue(result);
    await expect(saveLendingUsdtRepay(input)).rejects.toThrow(result.reason);
    expect(input.signEnvelope).not.toHaveBeenCalled();
  });
  it.each(["settings", "budget", "split", "cap"])("does not claim success if read-back changes %s", async field => {
    const { input, before, after } = setup();
    const changed = field === "settings" ? recovered("13000000000000000000")
      : field === "cap" ? { ...after, reserveCapWei: "28000000000000000000" }
        : { ...after, values: { ...after.values, ...(field === "budget" ? { budgetWei: "50000000000000000" } : { reserveBps: 3000 }) } };
    input.readCurrent.mockReset().mockResolvedValueOnce(before).mockResolvedValueOnce(changed);
    await expect(saveLendingUsdtRepay(input)).rejects.toThrow("could not be confirmed");
  });
  it("stops between a returned signature and POST when ownership changes", async () => {
    const { input } = setup();
    let stopped = false;
    input.signEnvelope.mockImplementation(async (action, agentId, params) => { stopped = true; return { action, agentId, params }; });
    input.check.mockImplementation(() => { if (stopped) throw new Error("owner changed"); });
    await expect(saveLendingUsdtRepay(input)).rejects.toThrow("owner changed");
    expect(input.fetcher).not.toHaveBeenCalled();
  });
  it("does not retry an ambiguous settings POST or return verified values", async () => {
    const { input } = setup();
    input.fetcher.mockRejectedValue(new Error("response lost"));
    await expect(saveLendingUsdtRepay(input)).rejects.toThrow("response lost");
    expect(input.fetcher).toHaveBeenCalledTimes(1);
    expect(input.readCurrent).toHaveBeenCalledTimes(1);
  });
  it("surfaces a refused settings POST", async () => {
    const { input } = setup();
    input.fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { message: "submission unresolved" } }), { status: 409 }));
    await expect(saveLendingUsdtRepay(input)).rejects.toThrow("submission unresolved");
    expect(input.readCurrent).toHaveBeenCalledTimes(1);
  });
});
