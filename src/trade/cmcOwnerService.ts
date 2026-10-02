/** Owner-admin CMC allowance/checker setup with delta-only top-ups. */
import { concat, encodeFunctionData, getAddress, hexToBytes, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { accountKeyHashForAddress } from "../wallet/altana.js";
import { canonicalEncode } from "../auth/canonical.js";
import {
  parseCmcBudgetAtomic,
  type CmcBudgetStore,
} from "./cmc.js";
import { CMC_PERMIT2, type CmcCapabilityGate } from "./cmcCapability.js";
import type { CmcBudgetRecord, CmcOwnerOperationRecord, CmcOwnerOperationMode, CmcStoredCall, CmcOwnerFailureProof, CmcOwnerExecutionProof } from "../store/tradeCmc.js";
import { USDT_56 } from "./settlement.js";

export const ERC20_INCREASE_ALLOWANCE_SELECTOR = "0x39509351" as Hex;

const ERC20_ADMIN_ABI = [{
  type: "function", name: "increaseAllowance", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "addedValue", type: "uint256" }], outputs: [{ type: "bool" }],
}] as const;
const CHECKER_ABI = [{
  type: "function", name: "setSignatureCheckerApproval", stateMutability: "nonpayable",
  inputs: [{ name: "keyHash", type: "bytes32" }, { name: "checker", type: "address" }, { name: "isApproved", type: "bool" }], outputs: [],
}] as const;

export type CmcOwnerCall = {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
};

export type CmcOwnerStateReader = {
  readState(input: {
    readonly agentId: string;
    readonly wallet: Address;
    readonly sessionPublicKey: Hex;
    readonly previousSessionPublicKey?: Hex;
    readonly nowSec: number;
  }): Promise<{
    readonly allowanceWei: bigint;
    readonly checkerApproved: boolean;
    readonly oldCheckerKeyHash: Hex | null;
  }>;
  verifyOwnerExecution(input: {
    readonly operation: CmcOwnerOperationRecord;
    readonly calls: readonly CmcOwnerCall[];
    readonly callsId: Hex;
  }): Promise<{
    readonly finalized: boolean;
    readonly callsDigest: Hex;
    readonly allowanceWei: bigint;
    readonly checkerApproved: boolean;
    readonly sessionKeyHash: Hex;
    readonly executionProof: CmcOwnerExecutionProof;
  }>;
};

export type CmcOwnerPrepared = {
  readonly operation: CmcOwnerOperationRecord;
  readonly budget: CmcBudgetRecord;
  readonly calls: readonly CmcOwnerCall[];
};

function ownerKey(value: Address): Address { return `0x${getAddress(value).slice(2).toLowerCase()}`; }
function isSame(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function keyHash(publicKey: Hex): Hex {
  return accountKeyHashForAddress(publicKeyToAddress(publicKey));
}
function digestCalls(calls: readonly CmcOwnerCall[]): Hex {
  return keccak256(Buffer.from(canonicalEncode(calls), "utf8"));
}

export function buildIncreaseAllowanceCall(input: { readonly amountWei: bigint }): CmcOwnerCall {
  if (input.amountWei <= 0n) throw new Error("CMC allowance increment must be positive.");
  const data = encodeFunctionData({ abi: ERC20_ADMIN_ABI, functionName: "increaseAllowance", args: [CMC_PERMIT2, input.amountWei] });
  if (data.slice(0, 10).toLowerCase() !== ERC20_INCREASE_ALLOWANCE_SELECTOR) throw new Error("CMC allowance selector mismatch.");
  return { to: USDT_56, value: 0n, data };
}

/**
 * CMC-HIRE-SETUP R1.4: a deterministic UUID derived from the provision action id
 * and a fixed tag, so the continuation's operation id is never caller-supplied.
 * `keccak256(concat([id, toBytes(tag)]))`, first 16 bytes, with the version and
 * variant nibbles forced so the result satisfies `wire.ts`'s UUID regex.
 */
export function hireCmcUuid(id: Hex, tag: string): string {
  const bytes = hexToBytes(keccak256(concat([hexToBytes(id), stringToBytes(tag)]))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildCheckerApprovalCall(input: {
  readonly wallet: Address;
  readonly keyHash: Hex;
  readonly approved: boolean;
}): CmcOwnerCall {
  return { to: getAddress(input.wallet), value: 0n, data: encodeFunctionData({ abi: CHECKER_ABI,
    functionName: "setSignatureCheckerApproval", args: [input.keyHash, CMC_PERMIT2, input.approved] }) };
}

export type CmcOwnerService = {
  prepare(input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly wallet: Address;
    readonly mode: CmcOwnerOperationMode;
    readonly expectedGeneration: number;
    readonly additionalBudgetWei: string;
    readonly sessionPublicKey: Hex;
    readonly sessionExpiry: number;
    readonly signedInitialTotalWei?: bigint;
    /** Told why the capability gate refused, so the route can name it (2026-09-23). */
    readonly onCapabilityRefusal?: (reason: string) => void;
    readonly nowSec?: number;
    readonly nowMs?: number;
  }): Promise<CmcOwnerPrepared | null>;
  recordAttempt(input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly attemptId: string;
    readonly callsId?: Hex;
    readonly nowMs?: number;
  }): Promise<CmcOwnerOperationRecord | null>;
  confirm(input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly calls?: readonly CmcOwnerCall[];
    readonly callsId: Hex;
    readonly nowMs?: number;
  }): Promise<{ readonly budget: CmcBudgetRecord; readonly operation: CmcOwnerOperationRecord } | null>;
  fail(input: {
    readonly operationId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly expectedGeneration: number;
    readonly proof: CmcOwnerFailureProof;
    readonly nowMs?: number;
  }): ReturnType<CmcBudgetStore["failOwnerOperation"]>;
};

export function createCmcOwnerService(input: {
  readonly store: CmcBudgetStore;
  readonly capability: CmcCapabilityGate;
  readonly chain: CmcOwnerStateReader;
  readonly now?: () => number;
}): CmcOwnerService {
  const clock = input.now ?? (() => Date.now());
  return {
    async prepare(request) {
      const amount = parseCmcBudgetAtomic(request.additionalBudgetWei, { allowZero: request.mode === "rebind" });
      if (amount === null || request.expectedGeneration < 0 || request.sessionExpiry <= Math.floor((request.nowSec ?? clock() / 1_000))) return null;
      const existing = await input.store.getOwnerOperation(request.agentId, request.ownerAddress, request.operationId);
      if (existing !== null) {
        if (existing.mode !== request.mode || existing.expectedGeneration !== request.expectedGeneration
          || existing.incrementWei !== amount || existing.sessionPublicKey.toLowerCase() !== request.sessionPublicKey.toLowerCase()
          || existing.sessionExpiry !== request.sessionExpiry) return null;
        const existingBudget = await input.store.get(request.agentId, request.ownerAddress);
        return existingBudget === null ? null : { operation: existing, budget: existingBudget, calls: existing.calls };
      }
      const budget = await input.store.get(request.agentId, request.ownerAddress);
      if (budget === null || budget.wallet.toLowerCase() !== request.wallet.toLowerCase() || !budget.optedIn || budget.pendingOperationId !== null || budget.pendingOwnerOperationId !== null
        || budget.generation !== request.expectedGeneration || budget.reservedWei !== 0n) return null;
      const verdict = await input.capability.check({ agentId: request.agentId, wallet: request.wallet,
        sessionPublicKey: request.sessionPublicKey, generation: budget.generation, nowMs: request.nowMs ?? clock() });
      if (!verdict.available) { request.onCapabilityRefusal?.(verdict.reason); return null; }
      const state = await input.chain.readState({ agentId: request.agentId, wallet: request.wallet,
        sessionPublicKey: request.sessionPublicKey,
        ...(budget.checkerSessionPublicKey === null ? {} : { previousSessionPublicKey: budget.checkerSessionPublicKey }),
        nowSec: request.nowSec ?? Math.floor(clock() / 1_000) });
      const newKeyHash = keyHash(request.sessionPublicKey);
      if (request.mode === "topup" && amount === 0n || request.mode === "rebind" && amount !== 0n) return null;
      const initial = request.mode === "topup" && request.expectedGeneration === 0 && !budget.setupProved;
      if (initial) {
        // HOTFIX 2026-09-22 (operator): a re-hired passkey wallet keeps the removed
        // agent's Permit2 allowance on chain. The initial setup ADOPTS it: the
        // increase call adds the signed amount on top, `expectedAllowanceWei`
        // is prior + amount, and confirm records that total as authorised.
        if (request.signedInitialTotalWei === undefined || request.signedInitialTotalWei !== amount
          || state.checkerApproved) return null;
      } else if (!budget.setupProved || state.allowanceWei !== (budget.allowanceWei ?? -1n)) return null;
      const calls: CmcOwnerCall[] = [];
      if (request.mode === "topup") calls.push(buildIncreaseAllowanceCall({ amountWei: amount }));
      if (state.oldCheckerKeyHash !== null && !isSame(state.oldCheckerKeyHash, newKeyHash)) calls.push(buildCheckerApprovalCall({ wallet: request.wallet, keyHash: state.oldCheckerKeyHash, approved: false }));
      calls.push(buildCheckerApprovalCall({ wallet: request.wallet, keyHash: newKeyHash, approved: true }));
      const operation = await input.store.prepareOwnerOperation({
        operationId: request.operationId, agentId: request.agentId, ownerAddress: ownerKey(request.ownerAddress),
        mode: request.mode, expectedGeneration: request.expectedGeneration, incrementWei: amount,
        sessionPublicKey: request.sessionPublicKey, sessionExpiry: request.sessionExpiry,
        priorAllowanceWei: state.allowanceWei,
        expectedAllowanceWei: request.mode === "topup" ? state.allowanceWei + amount : state.allowanceWei,
        wallet: request.wallet,
        oldCheckerKeyHash: state.oldCheckerKeyHash,
        keyHash: newKeyHash, callsDigest: digestCalls(calls), nowMs: request.nowMs ?? clock(),
        calls: calls as readonly CmcStoredCall[],
      });
      if (operation === null) return null;
      return { operation, budget: (await input.store.get(request.agentId, request.ownerAddress)) ?? budget, calls };
    },
    recordAttempt(request) { return input.store.recordOwnerAttempt(request); },
    async confirm(request) {
      const operation = await input.store.getOwnerOperation(request.agentId, request.ownerAddress, request.operationId);
      if (operation === null) return null;
      const calls = request.calls ?? operation.calls;
      const verified = await input.chain.verifyOwnerExecution({ operation, calls, callsId: request.callsId });
      if (!verified.finalized || !isSame(verified.callsDigest, operation.callsDigest)
        || !verified.checkerApproved || !isSame(verified.sessionKeyHash, operation.keyHash)
        || verified.executionProof.wallet.toLowerCase() !== operation.wallet.toLowerCase()
        || verified.allowanceWei < 0n) return null;
      return input.store.confirmOwnerOperation({ operationId: request.operationId, agentId: request.agentId,
        ownerAddress: request.ownerAddress, expectedGeneration: operation.expectedGeneration,
        callsId: request.callsId, allowanceWei: verified.allowanceWei,
        executionProof: verified.executionProof, nowMs: request.nowMs ?? clock() });
    },
    fail(request) { return input.store.failOwnerOperation(request); },
  };
}
