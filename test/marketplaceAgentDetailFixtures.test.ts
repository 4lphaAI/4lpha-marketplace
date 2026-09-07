import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/marketplace-agent-detail/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

describe("marketplace agent detail sanitized local-harness captures", () => {
  it("pins the owner projection without any transport credential", () => {
    const captured = fixture("local-harness-grid-arm.owner.json");
    const data = captured["data"] as Record<string, unknown>;
    assert.equal(data["id"], "agent-grid-routes");
    assert.equal(data["status"], "armed");
    assert.equal("authorization" in captured, false);
    assert.equal("x-owner-action" in captured, false);
    assert.equal("signature" in captured, false);
  });

  it("pins the empty-arm LP availability and lower-bound note", () => {
    const captured = fixture("local-harness-grid-arm.lp.json");
    const data = captured["data"] as Record<string, unknown>;
    const grid = data["grid"] as Record<string, unknown>;
    const cycles = grid["cycles"] as Record<string, unknown>;
    assert.equal(cycles["available"], true);
    assert.deepEqual(cycles["rows"], []);
    assert.equal(cycles["note"], "Derived telemetry: a row can be lost if the post-confirm write fails; counts are a lower bound.");
    assert.equal(grid["poolAddress"], null);
  });
});
