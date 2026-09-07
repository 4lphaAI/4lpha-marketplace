import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyRevokeCallsStatus, revokeAgentSession } from "./client";
import type { StoredPasskey } from "@/lib/exec/passkey";

const record: StoredPasskey = {
  x: `0x${"11".repeat(32)}`,
  y: `0x${"22".repeat(32)}`,
  credentialId: "credential",
  rpId: "example.test",
  createdAt: 1,
};

describe("dedicated Altana session revoke", () => {
  it("refuses a missing or mismatched stored owner wallet before SDK work", async () => {
    await expect(revokeAgentSession({
      record,
      ownerViewWalletAddress: "0x1111111111111111111111111111111111111111",
      sessionPublicKey: `0x${"33".repeat(64)}`,
    })).rejects.toThrow(/no agent wallet/u);
    await expect(revokeAgentSession({
      record: { ...record, walletAddress: "0x2222222222222222222222222222222222222222" },
      ownerViewWalletAddress: "0x1111111111111111111111111111111111111111",
      sessionPublicKey: `0x${"33".repeat(64)}`,
    })).rejects.toThrow(/does not control/u);
  });

  it("uses revokeSession directly and never a generic execute batch", () => {
    const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export async function revokeAgentSession"), source.indexOf("/**\n * Send native BNB"));
    expect(body).toContain("createAltanaClient().revokeSession");
    expect(body).toContain("session: input.sessionPublicKey");
    expect(body).not.toContain(".execute(");
  });

  it("pins Porto's public status API and classifies only exact relay evidence", () => {
    const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    expect(source).toContain('from "porto/viem/RelayActions"');
    expect(source).not.toContain("porto/dist/internal");
    expect(packageJson.dependencies?.["porto"]).toBe("0.2.37");

    const callsId = "0x1234" as const;
    const transactionHash = `0x${"44".repeat(32)}` as const;
    const receipt = {
      chainId: 56,
      blockNumber: 101,
      blockHash: `0x${"55".repeat(32)}`,
      transactionHash,
      status: "0x1",
    };
    expect(classifyRevokeCallsStatus({ id: callsId, status: 300 }, callsId)).toEqual({ kind: "pending", status: 300 });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 500 }, callsId)).toEqual({ kind: "failed", status: 500 });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: [receipt] }, callsId, transactionHash)).toMatchObject({ kind: "confirmed", receipt: { chainId: 56, blockNumber: 101 } });
    expect(classifyRevokeCallsStatus({ id: "0xabcd", status: 200, receipts: [receipt] }, callsId)).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: [{ ...receipt, chainId: 1 }] }, callsId)).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: [{ ...receipt, status: "0x0" }] }, callsId)).toEqual({ kind: "failed", status: 500 });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: [{ ...receipt, status: "0x" }] }, callsId)).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: [{ ...receipt, status: "0x01" }] }, callsId)).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: [{ ...receipt, status: `0x${"f".repeat(1024)}` }] }, callsId)).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: [null] }, callsId)).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: ["receipt"] }, callsId)).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: [[]] }, callsId)).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: "0x", status: 300 }, "0x")).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: callsId, status: 200, receipts: [] }, callsId)).toEqual({ kind: "unreadable" });
    expect(classifyRevokeCallsStatus({ id: callsId, status: "200", receipts: [receipt] }, callsId)).toEqual({ kind: "unreadable" });
  });
});
