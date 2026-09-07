import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

const sdk = vi.hoisted(() => ({ grantSession: vi.fn(), signerFromPasskey: vi.fn(() => ({ type: "passkey" })) }));
vi.mock("@altananetwork/sdk", async (load) => {
  const actual = await load<typeof import("@altananetwork/sdk")>();
  return {
    ...actual,
    createClient: () => ({ grantSession: (input: unknown) => sdk.grantSession(input) }),
    signerFromPasskey: sdk.signerFromPasskey,
  };
});

import { grantAgentSession, GrantAgentSessionError } from "./client";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const record = {
  credentialId: "credential",
  x: `0x${"22".repeat(32)}` as const,
  y: `0x${"33".repeat(32)}` as const,
  walletAddress: "0x2222222222222222222222222222222222222222" as const,
  rpId: "4lpha.test",
  createdAt: 1,
};

describe("grantAgentSession", () => {
  beforeEach(() => { sdk.grantSession.mockReset(); });

  it("submits a public-key-only signer and never reaches its signDigest thrower", async () => {
    sdk.grantSession.mockImplementation(async (input: { sessionSigner: { publicKey: string; signDigest: () => Promise<string>; _privateKey?: string }; expiry: number }) => {
      expect(input.sessionSigner.publicKey).toBe(account.publicKey);
      expect("_privateKey" in input.sessionSigner).toBe(false);
      return { publicKey: input.sessionSigner.publicKey, expiry: input.expiry };
    });
    await expect(grantAgentSession({
      record,
      walletAddress: record.walletAddress,
      permissions: { calls: [{ to: record.walletAddress }], spend: [{ period: "day", limit: 1n }] },
      expiry: 2_000_000_000,
      sessionPublicKey: account.publicKey,
      sessionAddress: account.address,
    })).resolves.toEqual({ publicKey: account.publicKey, expiry: 2_000_000_000 });
  });

  it("turns an SDK call to the stub signer red and maps it into the closed boundary", async () => {
    sdk.grantSession.mockImplementation(async (input: { sessionSigner: { signDigest: (digest: `0x${string}`) => Promise<string> } }) =>
      input.sessionSigner.signDigest(`0x${"00".repeat(32)}`));
    await expect(grantAgentSession({
      record, walletAddress: record.walletAddress, permissions: {}, expiry: 2_000_000_000,
      sessionPublicKey: account.publicKey, sessionAddress: account.address,
    })).rejects.toMatchObject({ code: "grant_unknown" } satisfies Partial<GrantAgentSessionError>);
  });

  it("maps only structural SDK/browser evidence and never exposes the raw cause", async () => {
    const cases = [
      [Object.assign(new Error("secret rejected request"), { name: "NotAllowedError" }), "grant_rejected"],
      [Object.assign(new Error("secret relay URL https://relay.invalid"), { name: "TimeoutError" }), "grant_pending"],
      [Object.assign(new Error(`secret 0x${"aa".repeat(32)}`), { name: "InsufficientFundsError" }), "grant_underfunded"],
      [new Error("Session grant did not confirm: status=PENDING"), "grant_pending"],
      [new Error("Session grant did not confirm: status=FAILED"), "grant_failed"],
      [new Error("Session grant did not confirm: status=FAILED (relay code 500)"), "grant_failed"],
      [new Error(`timeout-looking but untyped https://rpc.invalid 0x${"bb".repeat(32)}`), "grant_unknown"],
    ] as const;
    for (const [cause, code] of cases) {
      sdk.grantSession.mockRejectedValueOnce(cause);
      try {
        await grantAgentSession({
          record, walletAddress: record.walletAddress, permissions: {}, expiry: 2_000_000_000,
          sessionPublicKey: account.publicKey, sessionAddress: account.address,
        });
        expect.unreachable("grant should throw");
      } catch (error) {
        expect(error).toMatchObject({ code, message: code });
        expect(String(error)).not.toContain("https://");
        expect(String(error)).not.toContain("aaaa");
        expect(String(error)).not.toContain("bbbb");
      }
    }
  });
});
