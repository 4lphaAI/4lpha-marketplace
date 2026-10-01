import { expect, it } from "vitest";
import { parseErc8004Identity } from "./erc8004-identity";

it("accepts all four TradFi identity categories and rejects an unknown one", () => {
  const pending = { version: 1, publicRef: "00000000-0000-4000-8000-000000000001", revision: 1, category: "grid", status: "pending", agentId: null, registrationTxHash: null, uriUpdateTxHash: null, errorCode: null };
  for (const category of ["tradfi-trade", "tradfi-schedule", "tradfi-dca", "tradfi-portfolio"]) {
    const identity = { ...pending, category };
    expect(parseErc8004Identity(identity)).toEqual(identity);
  }
  expect(parseErc8004Identity({ ...pending, category: "tradfi-unknown" })).toEqual({ status: "blocked", errorCode: "invalid_identity" });
});
