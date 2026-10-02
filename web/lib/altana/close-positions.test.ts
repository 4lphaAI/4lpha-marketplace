import { decodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredPasskey } from "@/lib/exec/passkey";

// AUTO-DCA R2.11 — the pull-all batch builder: two calls per position, one execute, the reader's minimums.
const sdk = vi.hoisted(() => ({ execute: vi.fn(async () => ({ status: "CONFIRMED", callsId: `0x${"ab".repeat(32)}` })) }));
vi.mock("@altananetwork/sdk", () => ({
  BNB: {},
  createClient: () => ({ execute: sdk.execute }),
  signerFromPasskey: () => ({ signDigest: async () => "0x" }),
}));

import { closeLpPositionWithPasskey, closeLpPositionsWithPasskey } from "./client";

const WALLET = "0x2222222222222222222222222222222222222222" as const;
const NFPM = "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364" as const;
const record: StoredPasskey = { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}`, credentialId: "credential", rpId: "example.test", createdAt: 1, walletAddress: WALLET };
const ABI = [
  { type: "function", name: "decreaseLiquidity", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenId", type: "uint256" }, { name: "liquidity", type: "uint128" }, { name: "amount0Min", type: "uint256" },
    { name: "amount1Min", type: "uint256" }, { name: "deadline", type: "uint256" }] }], outputs: [] },
  { type: "function", name: "collect", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenId", type: "uint256" }, { name: "recipient", type: "address" }, { name: "amount0Max", type: "uint128" },
    { name: "amount1Max", type: "uint128" }] }], outputs: [] },
] as const;

type Call = { readonly to: string; readonly value: bigint; readonly data: `0x${string}` };
function executedCalls(): readonly Call[] {
  return (sdk.execute.mock.calls.at(-1) as unknown as [{ readonly calls: readonly Call[] }])[0].calls;
}

describe("closeLpPositionsWithPasskey (R2.11)", () => {
  beforeEach(() => { sdk.execute.mockClear(); });

  it("builds [decreaseLiquidity, collect(→ wallet)] per position in ONE execute, at the reader's minimums", async () => {
    const positions = [
      { tokenId: 7n, liquidity: 100n, amount0Min: 11n, amount1Min: 0n },
      { tokenId: 8n, liquidity: 200n, amount0Min: 0n, amount1Min: 22n },
      { tokenId: 9n, liquidity: 300n, amount0Min: 33n, amount1Min: 44n },
    ];
    const result = await closeLpPositionsWithPasskey({ record, nfpm: NFPM, positions, deadlineSec: 1_000n });
    expect(result.status).toBe("CONFIRMED");
    expect(sdk.execute).toHaveBeenCalledTimes(1);
    const calls = executedCalls();
    expect(calls).toHaveLength(6);
    positions.forEach((position, index) => {
      const decrease = decodeFunctionData({ abi: ABI, data: calls[index * 2]!.data });
      const collect = decodeFunctionData({ abi: ABI, data: calls[index * 2 + 1]!.data });
      expect(calls[index * 2]!.to).toBe(NFPM);
      expect(decrease.functionName).toBe("decreaseLiquidity");
      expect(decrease.args[0]).toEqual({ tokenId: position.tokenId, liquidity: position.liquidity, amount0Min: position.amount0Min, amount1Min: position.amount1Min, deadline: 1_000n });
      expect(collect.functionName).toBe("collect");
      expect((collect.args[0] as { tokenId: bigint; recipient: string }).tokenId).toBe(position.tokenId);
      expect((collect.args[0] as { recipient: string }).recipient.toLowerCase()).toBe(WALLET);
    });
  });

  it("the one-position close is the same batch with one position; empty, over three, or a dry position refuse before any prompt", async () => {
    await closeLpPositionWithPasskey({ record, nfpm: NFPM, tokenId: 7n, liquidity: 100n, amount0Min: 1n, amount1Min: 2n, deadlineSec: 5n });
    expect(executedCalls()).toHaveLength(2);
    sdk.execute.mockClear();
    const one = { tokenId: 1n, liquidity: 1n, amount0Min: 1n, amount1Min: 1n };
    await expect(closeLpPositionsWithPasskey({ record, nfpm: NFPM, positions: [], deadlineSec: 5n })).rejects.toThrow(/one to three/u);
    await expect(closeLpPositionsWithPasskey({ record, nfpm: NFPM, positions: [one, one, one, one], deadlineSec: 5n })).rejects.toThrow(/one to three/u);
    await expect(closeLpPositionsWithPasskey({ record, nfpm: NFPM, positions: [{ ...one, liquidity: 0n }], deadlineSec: 5n })).rejects.toThrow(/no liquidity/u);
    expect(sdk.execute).not.toHaveBeenCalled();
  });
});
