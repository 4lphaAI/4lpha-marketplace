import { describe, expect, it } from "vitest";
import { cancellationMessage, cancellationRecorded, forgetHire } from "./grid-hire-recovery";
import type { HireSessionView } from "./hire-state";

describe("canceled hire recovery copy", () => {
  for (const revocationRequired of [false, true]) it(`states retention and replacement honestly with authority=${revocationRequired}`, () => {
    const view = { status: "provisioning", cancelRequested: true, revocationRequired } as HireSessionView;
    const message = cancellationMessage(view);
    expect(message).toContain("will not activate");
    expect(message).toContain("record stays in Account until expiry");
    expect(message).toContain("start a new hire now");
    expect(message.includes("still needs revoking")).toBe(revocationRequired);
    expect(cancellationRecorded(view)).toBe(true);
  });
  it("does not treat a server-refused malformed marker as cancellation", () => {
    expect(cancellationRecorded({ status: "provisioning", cancelRequested: false } as HireSessionView)).toBe(false);
  });
});

it("does not clear an unrelated or malformed Trading JSON pointer", () => {
  for (const saved of ['{"agentId":"another"}', '{broken', 'null']) {
    const removed: string[] = [];
    forgetHire({ getItem: () => saved, removeItem: key => { removed.push(key); } }, "target", "4lpha:trade-hire:v2");
    expect(removed).toEqual([]);
  }
});
