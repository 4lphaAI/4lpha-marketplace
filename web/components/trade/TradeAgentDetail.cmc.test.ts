import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./TradeAgentDetail.tsx", import.meta.url), "utf8");

describe("CMC budget owner controls", () => {
  it("records the account-read attempt before owner calls and confirms by operation identity", () => {
    const attempt = source.indexOf("const attemptResponse = await accountPost");
    const admin = source.indexOf("const result = await executeCmcBudgetCalls");
    const confirm = source.indexOf("await confirmPending(withCallsId, result.callsId)");
    expect(attempt).toBeGreaterThan(-1);
    expect(admin).toBeGreaterThan(attempt);
    expect(confirm).toBeGreaterThan(admin);
    expect(source).toContain("JSON.stringify({ operationId, attemptId })");
    expect(source).toContain("JSON.stringify({ operationId: operation.operationId, callsId })");
    expect(source).toContain("The data-access wallet operation failed. It was kept for explicit recovery and was not retried.");
  });

  it("keeps unavailable capability explicit and does not paint a paid budget ready", () => {
    expect(source).toContain("Not ready yet: payment capability is not verified for this wallet.");
    expect(source).toContain("Data-access setup is unavailable until the execution plane returns the verified owner call batch.");
    expect(source).toContain('status === "ready" ? "Ready"');
  });
});
