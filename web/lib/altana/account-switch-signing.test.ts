// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ sign: vi.fn(), execute: vi.fn() }));
vi.mock("@altananetwork/sdk", async (load) => ({ ...await load<typeof import("@altananetwork/sdk")>(),
  signerFromPasskey: () => ({ signDigest: mock.sign }), createClient: () => ({ execute: mock.execute }) }));
import { withdrawNative } from "./client";
import { PASSKEY_STORAGE_KEY, type StoredPasskey } from "@/lib/exec/passkey";
const record: StoredPasskey = { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}`, credentialId: "YQ", rpId: "localhost", createdAt: 1, walletAddress: "0x1111111111111111111111111111111111111111" };
it("refuses an SDK signature completed after account change before execute can submit", async () => {
  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(record));
  let finish!: (value: string) => void;
  const submitted = vi.fn();
  mock.sign.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
  mock.execute.mockImplementation(async ({ signer }: { signer: { signDigest: (hash: string) => Promise<string> } }) => {
    await signer.signDigest("0x00"); submitted(); return { status: "CONFIRMED", callsId: "0x01" };
  });
  const operation = withdrawNative({ record, to: record.walletAddress!, valueWei: 1n });
  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify({ ...record, credentialId: "Yg" }));
  finish("0x1234");
  await expect(operation).rejects.toThrow(/Account changed/);
  await expect(withdrawNative({ record, to: record.walletAddress!, valueWei: 1n })).rejects.toThrow(/Account changed/);
  expect(mock.sign).toHaveBeenCalledTimes(1); expect(submitted).not.toHaveBeenCalled();
  localStorage.clear();
});
