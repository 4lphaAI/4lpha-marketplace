import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mayPoll, pollStateForStatus } from "./use-agent-detail";

describe("agent detail polling lifecycle", () => {
  it("distinguishes 401, 429 and 502", () => {
    expect(pollStateForStatus(401)).toBe("auth-expired");
    expect(pollStateForStatus(429)).toBe("rate-limited");
    expect(pollStateForStatus(502)).toBe("execution-unavailable");
  });

  it("stops before bearer expiry", () => {
    expect(mayPoll(10_000, 15_001)).toBe(true);
    expect(mayPoll(10_000, 15_000)).toBe(false);
    expect(mayPoll(15_001, 15_000)).toBe(false);
  });

  it("keeps signing out of effects and timer callbacks", () => {
    const source = readFileSync(fileURLToPath(new URL("./use-agent-detail.ts", import.meta.url)), "utf8");
    const effect = source.slice(source.indexOf("useEffect(() =>"));
    expect(effect).not.toMatch(/signIn\s*\(/u);
    expect(effect).not.toMatch(/signEnvelope\s*\(/u);
    expect(source).toContain("clearInterval(ownerTimer)");
    expect(source).toContain("clearInterval(marketTimer)");
    expect(source).toContain("abortRef.current?.abort()");
    expect(source).toContain("marketAbortRef.current?.abort()");
  });
});
