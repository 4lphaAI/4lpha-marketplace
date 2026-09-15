import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionRenew } from "./SessionRenew";

vi.mock("@/lib/exec/use-owner-actions", () => ({
  useOwnerActions: () => ({ passkey: null, walletAddress: undefined, signEnvelope: vi.fn() }),
}));

describe("SessionRenew", () => {
  it("states that renewal opens when the session ends", () => {
    const html = renderToStaticMarkup(<SessionRenew agentId="agent" walletAddress="0x2222222222222222222222222222222222222222" sessionExpiresAt={Math.floor(Date.now() / 1_000) + 3_600} kind="trade" />);
    expect(html).toContain("Renewal opens when the session ends.");
  });
});
