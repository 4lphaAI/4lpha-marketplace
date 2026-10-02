import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, keccak256, padHex } from "viem";
import { publicKeyToAddress } from "viem/utils";
import { CMC_PERMIT2, CMC_USDT, validateCmcBudgetCallPlan } from "./cmc-budget";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const SESSION = `0x04${"22".repeat(64)}` as `0x${string}`;
const INCREMENT = "2000000000000000000";

function keyHash(): `0x${string}` {
  const address = publicKeyToAddress(SESSION);
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, keccak256(padHex(address, { size: 32 }))]));
}

function prepared(calls: readonly { readonly to: string; readonly value: string; readonly data: string }[]) {
  return {
    operation: {
      operationId: "op-1", mode: "topup", expectedGeneration: 0, incrementWei: INCREMENT,
      sessionPublicKey: SESSION, wallet: WALLET, keyHash: keyHash(), oldCheckerKeyHash: null,
    },
    calls,
  };
}

describe("CMC owner call plan", () => {
  it("accepts only the exact USDT delta and current checker approval", () => {
    const allowance = encodeFunctionData({ abi: [{ type: "function", name: "increaseAllowance", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "addedValue", type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "increaseAllowance", args: [CMC_PERMIT2, BigInt(INCREMENT)] });
    const checker = encodeFunctionData({ abi: [{ type: "function", name: "setSignatureCheckerApproval", stateMutability: "nonpayable", inputs: [{ name: "keyHash", type: "bytes32" }, { name: "checker", type: "address" }, { name: "approved", type: "bool" }], outputs: [] }], functionName: "setSignatureCheckerApproval", args: [keyHash(), CMC_PERMIT2, true] });
    const calls = validateCmcBudgetCallPlan({ prepared: prepared([
      { to: CMC_USDT, value: "0", data: allowance }, { to: WALLET, value: "0", data: checker },
    ]), operationId: "op-1", mode: "topup", incrementWei: INCREMENT, expectedGeneration: 0, sessionPublicKey: SESSION, wallet: WALLET });
    expect(calls).toHaveLength(2);
  });

  it("rejects wrong targets, duplicate calls, and nonzero native value", () => {
    const allowance = encodeFunctionData({ abi: [{ type: "function", name: "increaseAllowance", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "addedValue", type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "increaseAllowance", args: [CMC_PERMIT2, BigInt(INCREMENT)] });
    expect(() => validateCmcBudgetCallPlan({ prepared: prepared([{ to: WALLET, value: "0", data: allowance }]), operationId: "op-1", mode: "topup", incrementWei: INCREMENT, expectedGeneration: 0, sessionPublicKey: SESSION, wallet: WALLET })).toThrow(/allowance call|checker call/u);
    expect(() => validateCmcBudgetCallPlan({ prepared: prepared([{ to: CMC_USDT, value: "1", data: allowance }]), operationId: "op-1", mode: "topup", incrementWei: INCREMENT, expectedGeneration: 0, sessionPublicKey: SESSION, wallet: WALLET })).toThrow(/native-value/u);
  });

  it("accepts a checker-only rebind and rejects an allowance call in that mode", () => {
    const checker = encodeFunctionData({ abi: [{ type: "function", name: "setSignatureCheckerApproval", stateMutability: "nonpayable", inputs: [{ name: "keyHash", type: "bytes32" }, { name: "checker", type: "address" }, { name: "approved", type: "bool" }], outputs: [] }], functionName: "setSignatureCheckerApproval", args: [keyHash(), CMC_PERMIT2, true] });
    const base = prepared([{ to: WALLET, value: "0", data: checker }]);
    const plan = { ...base, operation: { ...base.operation, mode: "rebind", incrementWei: "0", expectedGeneration: 1 } };
    expect(validateCmcBudgetCallPlan({ prepared: plan, operationId: "op-1", mode: "rebind", incrementWei: "0", expectedGeneration: 1, sessionPublicKey: SESSION, wallet: WALLET })).toHaveLength(1);
  });
});
