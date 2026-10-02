import {
  BNB,
  createClient as createAltanaSdkClient,
  signerFromPasskey,
  type PasskeyCredential,
  type Signer,
} from "@altananetwork/sdk";
import { decodeFunctionData, encodeAbiParameters, getAddress, isHex, keccak256, padHex, parseAbi, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/utils";
import { activePasskeyGuard, toAltanaCredential, type StoredPasskey } from "@/lib/exec/passkey";

const ALTANA_CHAIN_ID = 56;
export const CMC_PERMIT2: Address = getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3");
export const CMC_USDT: Address = getAddress("0x55d398326f99059ff775485246999027b3197955");

type CmcOwnerCall = { readonly to: Address; readonly value: bigint; readonly data: Hex };

const INCREASE_ALLOWANCE_ABI = parseAbi(["function increaseAllowance(address spender,uint256 addedValue) returns (bool)"]);
const CHECKER_APPROVAL_ABI = parseAbi(["function setSignatureCheckerApproval(bytes32 keyHash,address checker,bool approved)"]);

/** The account-key hash Altana's KeyStore indexes a session by (secp256k1, PERIOD_DAY etc. read by this hash). */
export function keyHashForSession(publicKey: Hex): Hex {
  const address = publicKeyToAddress(publicKey);
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }],
    [2n, keccak256(padHex(getAddress(address), { size: 32 }))],
  ));
}

function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

function storedCall(value: unknown): CmcOwnerCall | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as { readonly to?: unknown; readonly value?: unknown; readonly data?: unknown };
  if (typeof row.to !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(row.to)
    || typeof row.value !== "string" || !/^\d+$/u.test(row.value)
    || typeof row.data !== "string" || !/^0x[0-9a-fA-F]*$/u.test(row.data)) return null;
  return { to: getAddress(row.to), value: BigInt(row.value), data: row.data as Hex };
}

/**
 * Validate the prepared owner batch before the passkey prompt. The server's
 * persisted operation is the source of expected wallet/key/delta facts; the
 * browser independently checks every call target, selector and argument.
 */
export function validateCmcBudgetCallPlan(input: {
  readonly prepared: Record<string, unknown>;
  readonly operationId: string;
  readonly mode: "topup" | "rebind";
  readonly incrementWei: string;
  readonly expectedGeneration: number;
  readonly sessionPublicKey: Hex;
  readonly wallet: Address;
}): readonly CmcOwnerCall[] {
  const operation = typeof input.prepared.operation === "object" && input.prepared.operation !== null && !Array.isArray(input.prepared.operation)
    ? input.prepared.operation as Record<string, unknown> : null;
  if (operation === null || operation.operationId !== input.operationId || operation.mode !== input.mode
    || operation.expectedGeneration !== input.expectedGeneration || operation.incrementWei !== input.incrementWei
    || typeof operation.sessionPublicKey !== "string" || !same(operation.sessionPublicKey, input.sessionPublicKey)
    || typeof operation.wallet !== "string" || !same(operation.wallet, input.wallet)
    || typeof operation.keyHash !== "string" || !same(operation.keyHash, keyHashForSession(input.sessionPublicKey))) {
    throw new Error("The prepared CMC owner operation does not match the signed budget action.");
  }
  const rawCalls = input.prepared.calls ?? operation.calls;
  if (!Array.isArray(rawCalls) || rawCalls.length === 0 || rawCalls.length > 3) throw new Error("The prepared CMC owner operation has an invalid call count.");
  const calls = rawCalls.map(storedCall);
  if (calls.some((call): call is null => call === null)) throw new Error("The prepared CMC owner operation contains malformed calls.");
  const normalized = calls as CmcOwnerCall[];
  if (input.prepared.calls !== undefined && Array.isArray(operation.calls)) {
    const persisted = operation.calls.map(storedCall);
    if (persisted.some((call): call is null => call === null) || persisted.length !== normalized.length
      || persisted.some((call, index) => call === null || call.to.toLowerCase() !== normalized[index]!.to.toLowerCase()
        || call.value !== normalized[index]!.value || call.data.toLowerCase() !== normalized[index]!.data.toLowerCase())) {
      throw new Error("The prepared CMC owner calls do not match the persisted operation.");
    }
  }
  const unique = new Set(normalized.map((call) => `${call.to.toLowerCase()}:${call.data.toLowerCase()}:${call.value.toString(10)}`));
  if (unique.size !== normalized.length || normalized.some((call) => call.value !== 0n)) throw new Error("The prepared CMC owner operation contains duplicate or native-value calls.");
  const expectedKeyHash = keyHashForSession(input.sessionPublicKey);
  const oldKeyHash = typeof operation.oldCheckerKeyHash === "string" ? operation.oldCheckerKeyHash : null;
  const expectedWallet = getAddress(input.wallet);
  let incrementCount = 0;
  let newCheckerCount = 0;
  let oldCheckerCount = 0;
  for (const call of normalized) {
    if (same(call.to, CMC_USDT)) {
      if (input.mode !== "topup") throw new Error("A rebind cannot include a USDT allowance increment.");
      let decoded: readonly unknown[];
      try { decoded = decodeFunctionData({ abi: INCREASE_ALLOWANCE_ABI, data: call.data }).args; } catch { throw new Error("The CMC allowance call is malformed."); }
      if (decoded.length !== 2 || typeof decoded[0] !== "string" || !same(decoded[0], CMC_PERMIT2)
        || typeof decoded[1] !== "bigint" || decoded[1] !== BigInt(input.incrementWei)) throw new Error("The CMC allowance call is not the signed Permit2 delta.");
      incrementCount += 1;
      continue;
    }
    if (!same(call.to, expectedWallet)) throw new Error("The CMC checker call targets a different wallet.");
    let decoded: readonly unknown[];
    try { decoded = decodeFunctionData({ abi: CHECKER_APPROVAL_ABI, data: call.data }).args; } catch { throw new Error("The CMC checker call is malformed."); }
    if (decoded.length !== 3 || typeof decoded[0] !== "string" || typeof decoded[1] !== "string" || typeof decoded[2] !== "boolean"
      || !same(decoded[1], CMC_PERMIT2)) throw new Error("The CMC checker call is not bound to Permit2.");
    if (decoded[2] === true && same(decoded[0], expectedKeyHash)) newCheckerCount += 1;
    else if (decoded[2] === false && oldKeyHash !== null && same(decoded[0], oldKeyHash) && !same(oldKeyHash, expectedKeyHash)) oldCheckerCount += 1;
    else throw new Error("The CMC checker call is not bound to the expected session key.");
  }
  if (input.mode === "topup" && incrementCount !== 1) throw new Error("The CMC top-up must contain one exact allowance increment.");
  if (input.mode === "rebind" && incrementCount !== 0) throw new Error("The CMC rebind must not change allowance.");
  const needsOldRevoke = oldKeyHash !== null && !same(oldKeyHash, expectedKeyHash);
  if (newCheckerCount !== 1 || oldCheckerCount !== (needsOldRevoke ? 1 : 0)) throw new Error("The CMC checker transition is incomplete.");
  return normalized;
}

function selectedSigner(record: StoredPasskey): Signer {
  const signer = signerFromPasskey(toAltanaCredential(record) as PasskeyCredential);
  const check = activePasskeyGuard(record);
  return { ...signer, signDigest: async (...args: Parameters<Signer["signDigest"]>) => {
    check();
    const signature = await signer.signDigest(...args);
    check();
    return signature;
  } };
}

export type CmcOwnerExecuteResult = {
  readonly status: "PENDING" | "CONFIRMED" | "FAILED";
  readonly callsId: Hex;
  readonly transactionHash?: Hex;
};

/** Submit the bounded owner call batch returned by the prepared budget operation. */
export async function executeCmcBudgetCalls(input: {
  readonly record: StoredPasskey;
  readonly calls: readonly CmcOwnerCall[];
}): Promise<CmcOwnerExecuteResult> {
  const walletAddress = input.record.walletAddress;
  if (!walletAddress) throw new Error("This passkey has no agent wallet yet.");
  if (input.calls.length === 0 || input.calls.length > 4) throw new Error("The CMC owner operation returned an invalid call batch.");
  for (const call of input.calls) {
    if (!/^0x[0-9a-fA-F]{40}$/u.test(call.to) || call.value < 0n || !isHex(call.data)) {
      throw new Error("The CMC owner operation returned invalid call data.");
    }
  }
  const result = await createAltanaSdkClient({ chains: [BNB], defaultChainId: ALTANA_CHAIN_ID }).execute({
    wallet: { address: walletAddress },
    signer: selectedSigner(input.record),
    chainId: ALTANA_CHAIN_ID,
    calls: input.calls,
  });
  return {
    status: result.status,
    callsId: result.callsId,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}
