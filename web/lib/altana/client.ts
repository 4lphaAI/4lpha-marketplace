"use client";

/**
 * THE one module that imports `@altananetwork/sdk`.
 *
 * Everything admin-signed for wallet B happens here, in the browser, with the
 * user's passkey. The execution plane holds NO admin key for B and is not on
 * this path at all: it never sees wallet creation, never sees a withdrawal, and
 * only learns B later as an agent row's `walletAddress`.
 *
 * CUSTODY, stated exactly (FINDINGS (bg), memory: altana-browser-custody-is-passkey):
 * the wallet is NOT the user's MetaMask EOA. Altana closed injected-signer
 * support as unbuildable, so `createPasskeyWallet` signs the EIP-7702 upgrade
 * with a ONE-SHOT throwaway secp256k1 and discards it — B is that throwaway's
 * address, and the passkey is its sole authority. There IS a funding step.
 *
 * COUNTERFACTUAL: `createPasskeyWallet` lands no transaction. The delegation is
 * a preCall that rides the wallet's FIRST execute, which also prepends a
 * KeyStore `initialRegisterKey`. So the first withdrawal costs more gas than
 * every later one, and the UI says so.
 */

import {
  BNB,
  createClient as createAltanaSdkClient,
  signerFromPasskey,
  type PasskeyCredential,
  type SessionPermissions,
  type Signer,
} from "@altananetwork/sdk";
import { getCallsStatus } from "porto/viem/RelayActions";
import type { Address, Hex } from "viem";
import { UINT128_MAX } from "./nfpm";
import { createClient as createViemClient, encodeFunctionData, getAddress, http, isHex, size } from "viem";
import { publicKeyToAddress } from "viem/utils";
import {
  fromAltanaCredential,
  activePasskeyGuard,
  passkeyRpId,
  toAltanaCredential,
  type AltanaPasskeyCredential,
  type StoredPasskey,
} from "@/lib/exec/passkey";

/** BNB Smart Chain mainnet. The marketplace runs on one chain (CLAUDE.md). */
export const ALTANA_CHAIN_ID = 56;

/**
 * Compile-time proof that our SDK-free restatement in `passkey.ts` still
 * matches the SDK's own type. If Altana changes `PasskeyCredential`, this line
 * fails `tsc` rather than failing a user's withdrawal.
 */
const _credentialShapeIsAssignable: PasskeyCredential = {
  kind: "webauthn",
  id: "",
  publicKey: `0x${"00".repeat(64)}`,
} satisfies AltanaPasskeyCredential;
void _credentialShapeIsAssignable;

export function createAltanaClient() {
  return createAltanaSdkClient({ chains: [BNB], defaultChainId: ALTANA_CHAIN_ID });
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

/** The BscScan link for a hash. Kept here so the chain choice has one home. */
export function explorerTxUrl(hash: Hex): string {
  return `${BNB.explorer.replace(/\/+$/u, "")}/tx/${hash}`;
}

export type GrantAgentSessionErrorCode =
  | "grant_rejected"
  | "grant_pending"
  | "grant_failed"
  | "grant_underfunded"
  | "grant_unknown";

export class GrantAgentSessionError extends Error {
  readonly code: GrantAgentSessionErrorCode;
  constructor(code: GrantAgentSessionErrorCode) {
    super(code);
    this.name = "GrantAgentSessionError";
    this.code = code;
  }
}

function grantErrorCode(error: unknown): GrantAgentSessionErrorCode {
  if (typeof error !== "object" || error === null) return "grant_unknown";
  const candidate = error as { readonly name?: unknown; readonly code?: unknown; readonly message?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const code = typeof candidate.code === "string" || typeof candidate.code === "number" ? String(candidate.code) : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (["NotAllowedError", "AbortError", "UserRejectedRequestError"].includes(name) || code === "4001") return "grant_rejected";
  if (["TimeoutError", "HttpRequestError"].includes(name) || ["TIMEOUT", "ETIMEDOUT"].includes(code)) return "grant_pending";
  if (["InsufficientFundsError", "FeeCapTooLowError"].includes(name) || code === "INSUFFICIENT_FUNDS") return "grant_underfunded";
  if (name === "Error") {
    const nonConfirmation = /^Session grant did not confirm: status=(FAILED|REVERTED|PENDING)/u.exec(message);
    if (nonConfirmation?.[1] === "PENDING") return "grant_pending";
    if (nonConfirmation !== null) return "grant_failed";
  }
  return "grant_unknown";
}

/** Browser-only S2 adapter. The session private key never crosses this boundary. */
export async function grantAgentSession(input: {
  readonly record: StoredPasskey;
  readonly walletAddress: Address;
  readonly permissions: SessionPermissions;
  readonly expiry: number;
  readonly sessionPublicKey: Hex;
  readonly sessionAddress: Address;
}): Promise<{ readonly publicKey: Hex; readonly expiry: number }> {
  if (getAddress(publicKeyToAddress(input.sessionPublicKey)) !== getAddress(input.sessionAddress)) {
    throw new GrantAgentSessionError("grant_unknown");
  }
  const sessionSigner: Signer = {
    type: "privateKey",
    address: getAddress(input.sessionAddress),
    publicKey: input.sessionPublicKey,
    async signDigest(): Promise<Hex> {
      throw new Error("session stub must never sign");
    },
  };
  try {
    const session = await createAltanaClient().grantSession({
      wallet: { address: getAddress(input.walletAddress) },
      signer: selectedSigner(input.record),
      chainId: ALTANA_CHAIN_ID,
      permissions: input.permissions,
      expiry: input.expiry,
      sessionSigner,
    });
    return { publicKey: session.publicKey, expiry: session.expiry };
  } catch (error) {
    if (error instanceof GrantAgentSessionError) throw error;
    throw new GrantAgentSessionError(grantErrorCode(error));
  }
}

/**
 * Run Altana's ceremony and hand back OUR record.
 *
 * ONE credential does both jobs (memory: owner-identity-is-the-passkey): it is
 * the admin key of B and the key our `4lpha-p256-owner:v1:` derivation turns
 * into the owner identity. That is why the record is built from the SDK's own
 * credential rather than from a second `navigator.credentials.create()` — two
 * ceremonies would produce two keys and two identities.
 *
 * `rpId` MUST match the plane's `PASSKEY_RP_ID`; a credential registered under
 * a different RP ID signs owner actions the plane refuses.
 */
export async function createPasskeyWallet(input: {
  readonly name: string;
  readonly rpId?: string;
  readonly label?: string;
}): Promise<StoredPasskey> {
  const rpId = input.rpId ?? passkeyRpId();
  if (rpId === "") throw new Error("No relying-party id is configured for passkeys.");
  const result = await createAltanaClient().createPasskeyWallet({ name: input.name, rpId });
  return recordFrom(result.signer.credential, result.address, rpId, input.label ?? input.name);
}

/**
 * Rebuild `{ credential, walletAddress }` from the passkey alone (D2).
 *
 * Altana bakes B into the WebAuthn user handle at creation, so a discoverable-
 * credential assertion plus two `eth_call`s against KeyStore return both the
 * address and the P256 public key. This ONLY works for a credential Altana's
 * own ceremony created — an R5 raw credential has a random user handle and is
 * unrecoverable this way.
 */
export async function recoverWalletFromPasskey(input?: {
  readonly rpId?: string;
  readonly label?: string;
}): Promise<StoredPasskey> {
  const rpId = input?.rpId ?? passkeyRpId();
  if (rpId === "") throw new Error("No relying-party id is configured for passkeys.");
  const result = await createAltanaClient().recoverFromPasskey({ rpId, chainId: ALTANA_CHAIN_ID });
  return recordFrom(result.signer.credential, result.address, rpId, input?.label);
}

/*
 * DELETED ON PURPOSE: `createWalletForExistingPasskey`.
 *
 * It gave an already-registered credential a wallet via the SDK's
 * bring-your-own-signer `createWallet`. Altana bakes the wallet address into
 * the WebAuthn USER HANDLE at registration, and that handle is fixed, so a
 * wallet made this way is the one wallet `recoverWalletFromPasskey` can never
 * find — on this device or any other. Every wallet this app creates now comes
 * from `createPasskeyWallet`, which registers the credential and the address
 * together, so recoverability is structural rather than a warning in the UI.
 */

export type WithdrawResult = {
  readonly status: "PENDING" | "CONFIRMED" | "FAILED";
  readonly callsId: Hex;
  readonly transactionHash?: Hex;
};

export type RevokeAgentSessionResult = WithdrawResult;

export type RevokeCallsStatus =
  | { readonly kind: "pending"; readonly status: number }
  | { readonly kind: "failed"; readonly status: number }
  | {
    readonly kind: "confirmed";
    readonly status: 200;
    readonly receipt: {
      readonly chainId: 56;
      readonly transactionHash: Hex;
      readonly blockNumber: number;
      readonly blockHash: Hex;
    };
  }
  | { readonly kind: "unreadable" };

/** Strictly classify the public Porto relay response; no status releases custody. */
export function classifyRevokeCallsStatus(
  value: unknown,
  requestedCallsId: Hex,
  expectedTransactionHash?: Hex,
): RevokeCallsStatus {
  if (!/^0x[0-9a-f]+$/iu.test(requestedCallsId) || typeof value !== "object" || value === null) return { kind: "unreadable" };
  const response = value as { readonly id?: unknown; readonly status?: unknown; readonly receipts?: unknown };
  if (typeof response.id !== "string" || response.id.toLowerCase() !== requestedCallsId.toLowerCase()
    || typeof response.status !== "number" || !Number.isSafeInteger(response.status)) return { kind: "unreadable" };
  if (response.status === 500) return { kind: "failed", status: 500 };
  if (response.status !== 200) return { kind: "pending", status: response.status };
  if (!Array.isArray(response.receipts) || response.receipts.length !== 1) return { kind: "unreadable" };
  const candidate = response.receipts[0];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return { kind: "unreadable" };
  const receipt = candidate as Record<string, unknown>;
  if (receipt["chainId"] !== ALTANA_CHAIN_ID
    || typeof receipt["blockNumber"] !== "number" || !Number.isSafeInteger(receipt["blockNumber"]) || receipt["blockNumber"] < 1
    || typeof receipt["transactionHash"] !== "string" || !isHex(receipt["transactionHash"]) || size(receipt["transactionHash"]) !== 32
    || typeof receipt["blockHash"] !== "string" || !isHex(receipt["blockHash"]) || size(receipt["blockHash"]) !== 32
    || typeof receipt["status"] !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(receipt["status"])) return { kind: "unreadable" };
  let receiptStatus: bigint;
  try { receiptStatus = BigInt(receipt["status"]); } catch { return { kind: "unreadable" }; }
  if (receiptStatus === 0n) return { kind: "failed", status: 500 };
  if (receiptStatus !== 1n) return { kind: "unreadable" };
  const transactionHash = receipt["transactionHash"] as Hex;
  if (expectedTransactionHash !== undefined
    && transactionHash.toLowerCase() !== expectedTransactionHash.toLowerCase()) return { kind: "unreadable" };
  return {
    kind: "confirmed",
    status: 200,
    receipt: {
      chainId: ALTANA_CHAIN_ID,
      transactionHash,
      blockNumber: receipt["blockNumber"],
      blockHash: receipt["blockHash"] as Hex,
    },
  };
}

/** One bounded, read-only status lookup through Porto's pinned public export. */
export async function readRevokeCallsStatus(
  callsId: Hex,
  expectedTransactionHash?: Hex,
): Promise<RevokeCallsStatus> {
  if (!/^0x[0-9a-f]+$/iu.test(callsId)) return { kind: "unreadable" };
  const relayClient = createViemClient({
    chain: BNB.chain,
    transport: http(BNB.relayUrl, { timeout: 12_000 }),
  });
  try {
    const response = await getCallsStatus(relayClient, { id: callsId });
    return classifyRevokeCallsStatus(response, callsId, expectedTransactionHash);
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Strip one recorded session key using Altana's dedicated revoke primitive.
 * The caller must still verify the KeyStore postcondition through the plane;
 * even CONFIRMED is a relay result, not the page's authoritative Removed state.
 */
export async function revokeAgentSession(input: {
  readonly record: StoredPasskey;
  readonly ownerViewWalletAddress: Address;
  readonly sessionPublicKey: Hex;
}): Promise<RevokeAgentSessionResult> {
  if (input.record.walletAddress === undefined) {
    throw new Error("This passkey has no agent wallet yet.");
  }
  const storedWallet = getAddress(input.record.walletAddress);
  if (storedWallet !== getAddress(input.ownerViewWalletAddress)) {
    throw new Error("This passkey does not control the agent wallet.");
  }
  const result = await createAltanaClient().revokeSession({
    wallet: { address: storedWallet },
    signer: selectedSigner(input.record),
    session: input.sessionPublicKey,
    chainId: ALTANA_CHAIN_ID,
  });
  return {
    status: result.status,
    callsId: result.callsId,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}

/**
 * Send native BNB out of B to an explicit destination.
 *
 * ONE call, no calldata. The passkey signs; the relay submits; B pays.
 *
 * `execute` returns `status: "FAILED"` WITHOUT THROWING (CLAUDE.md, FINDINGS) —
 * the single most expensive quirk in this SDK. The result is returned verbatim
 * so the caller cannot mistake a failure for a success, and the caller is
 * required to branch on `status`.
 */
export async function withdrawNative(input: {
  readonly record: StoredPasskey;
  readonly to: Address;
  readonly valueWei: bigint;
}): Promise<WithdrawResult> {
  const walletAddress = input.record.walletAddress;
  if (!walletAddress) throw new Error("This passkey has no agent wallet yet.");
  if (input.valueWei <= 0n) throw new Error("Enter an amount greater than zero.");
  const signer = selectedSigner(input.record);
  const result = await createAltanaClient().execute({
    wallet: { address: walletAddress },
    signer,
    chainId: ALTANA_CHAIN_ID,
    calls: [{ to: input.to, value: input.valueWei, data: "0x" }],
  });
  return {
    status: result.status,
    callsId: result.callsId,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}

/**
 * Send one ERC-20 out of wallet B, signed by the passkey.
 *
 * The door that did not exist. Every LP exit can leave a non-quote leg in the
 * wallet (a skipped optional conversion, a refused swap, an abandoned sweep),
 * and once the agent is REVOKED there is no session left for any plane-side
 * sweep to spend through — the passkey is then the only key that can move the
 * balance at all. One `transfer` call: no router, no quote, no slippage and no
 * deadline, so there is nothing here that can price the transfer wrongly.
 */
export async function withdrawToken(input: {
  readonly record: StoredPasskey;
  readonly token: Address;
  readonly to: Address;
  readonly amountAtomic: bigint;
}): Promise<WithdrawResult> {
  const walletAddress = input.record.walletAddress;
  if (!walletAddress) throw new Error("This passkey has no agent wallet yet.");
  if (input.amountAtomic <= 0n) throw new Error("Enter an amount greater than zero.");
  const signer = selectedSigner(input.record);
  const transfer = encodeFunctionData({
    abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
    functionName: "transfer",
    args: [input.to, input.amountAtomic],
  });
  const result = await createAltanaClient().execute({
    wallet: { address: walletAddress },
    signer,
    chainId: ALTANA_CHAIN_ID,
    calls: [{ to: input.token, value: 0n, data: transfer }],
  });
  return {
    status: result.status,
    callsId: result.callsId,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}

/**
 * Empty an NFPM position with the passkey — no session, no plane, no agent.
 *
 * The last-resort door, and the only one that cannot be closed by anything the
 * plane believes. Under EIP-7702 the position NFT sits in the owner's own
 * wallet, so `decreaseLiquidity` + `collect` are calls the passkey may make
 * directly; the session is irrelevant, and so is whether the plane thinks the
 * row is open, closed, held or abandoned.
 *
 * MEASURED NEED (2026-09-03): abandoning one rung's exit closed BOTH rows of a
 * dual arm, and the agent was revoked 15 seconds later — leaving NFT 7316794
 * holding real liquidity with no in-product way to reach it. The plane bug is
 * fixed; this door exists so the next divergence between a row and the chain
 * costs an owner one click instead of a database edit.
 *
 * Both calls ride ONE atomic batch: a decrease whose collect did not follow
 * would leave the freed legs owed to the NFT rather than in the wallet.
 */
export async function closeLpPositionWithPasskey(input: {
  readonly record: StoredPasskey;
  readonly nfpm: Address;
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  readonly deadlineSec: bigint;
}): Promise<WithdrawResult> {
  const walletAddress = input.record.walletAddress;
  if (!walletAddress) throw new Error("This passkey has no agent wallet yet.");
  if (input.liquidity <= 0n) throw new Error("This position holds no liquidity.");
  const signer = selectedSigner(input.record);
  const decrease = encodeFunctionData({
    abi: [{ type: "function", name: "decreaseLiquidity", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenId", type: "uint256" }, { name: "liquidity", type: "uint128" },
      { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
      { name: "deadline", type: "uint256" }] }], outputs: [{ name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" }] }],
    functionName: "decreaseLiquidity",
    args: [{ tokenId: input.tokenId, liquidity: input.liquidity, amount0Min: input.amount0Min, amount1Min: input.amount1Min, deadline: input.deadlineSec }],
  });
  const collect = encodeFunctionData({
    abi: [{ type: "function", name: "collect", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenId", type: "uint256" }, { name: "recipient", type: "address" },
      { name: "amount0Max", type: "uint128" }, { name: "amount1Max", type: "uint128" }] }], outputs: [{ name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" }] }],
    functionName: "collect",
    args: [{ tokenId: input.tokenId, recipient: walletAddress as `0x${string}`, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }],
  });
  const result = await createAltanaClient().execute({
    wallet: { address: walletAddress },
    signer,
    chainId: ALTANA_CHAIN_ID,
    calls: [
      { to: input.nfpm, value: 0n, data: decrease },
      { to: input.nfpm, value: 0n, data: collect },
    ],
  });
  return {
    status: result.status,
    callsId: result.callsId,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}

/** Canonical WBNB on BNB Chain 56 — the quote leg every LP exit leaves behind. */
export const WBNB_ADDRESS_56: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

/**
 * Unwrap WBNB and send the same amount out as native BNB, in ONE atomic batch.
 *
 * Why this exists: a manual exit or a stop-loss returns the position's quote
 * leg as WBNB (FINDINGS (ag)), and the plane has no route that converts an idle
 * wallet balance — PHASE3.24 Part C was cut to a later phase. Until then the
 * only key that can move B's WBNB is the passkey, so the unwrap lives here,
 * beside the native withdrawal, and never touches the execution plane.
 *
 * The batch is WBNB.withdraw(amount) then a plain {to, value: amount}; the relay
 * executes both or neither, so a failed transfer cannot strand freshly
 * unwrapped BNB in a wallet the user then has to withdraw twice from.
 */
export async function withdrawWbnbAsNative(input: {
  readonly record: StoredPasskey;
  readonly to: Address;
  readonly amountWei: bigint;
}): Promise<WithdrawResult> {
  const walletAddress = input.record.walletAddress;
  if (!walletAddress) throw new Error("This passkey has no agent wallet yet.");
  if (input.amountWei <= 0n) throw new Error("Enter an amount greater than zero.");
  const signer = selectedSigner(input.record);
  const unwrap = encodeFunctionData({
    abi: [{ type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] }],
    functionName: "withdraw",
    args: [input.amountWei],
  });
  const result = await createAltanaClient().execute({
    wallet: { address: walletAddress },
    signer,
    chainId: ALTANA_CHAIN_ID,
    calls: [
      { to: WBNB_ADDRESS_56, value: 0n, data: unwrap },
      { to: input.to, value: input.amountWei, data: "0x" },
    ],
  });
  return {
    status: result.status,
    callsId: result.callsId,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}

/**
 * Bring the lending reserve home with the PASSKEY ALONE (§6.2, R2.5, R3.12).
 *
 * No session key, no plane, no server: after the seven-day expiry — or during
 * any outage — this is the door that cannot be closed by anything the plane
 * believes. The batch shape and its arithmetic live in `lending-recovery.ts` and
 * are unit-tested against fixed inputs; this function only carries them to the
 * SDK.
 *
 * The `withdrawWbnbAsNative` call shape is the precedent and NOTHING ELSE: its
 * `WBNB.withdraw` leg is the FINDINGS (at) trap. The router unwraps inside the
 * same multicall here.
 *
 * The result is returned VERBATIM — `execute` answers `status: "FAILED"` without
 * throwing (CLAUDE.md, FINDINGS), so the caller must branch on `status` and must
 * not read a resolved promise as success.
 */
export async function recoverLendingReserveWithPasskey(input: {
  readonly record: StoredPasskey;
  readonly calls: readonly { readonly to: Address; readonly value: bigint; readonly data: Hex }[];
}): Promise<WithdrawResult> {
  const walletAddress = input.record.walletAddress;
  if (!walletAddress) throw new Error("This passkey has no agent wallet yet.");
  if (input.calls.length === 0) throw new Error("There is nothing to recover.");
  const signer = selectedSigner(input.record);
  const result = await createAltanaClient().execute({
    wallet: { address: walletAddress },
    signer,
    chainId: ALTANA_CHAIN_ID,
    calls: input.calls.map((call) => ({ to: call.to, value: call.value, data: call.data })),
  });
  return {
    status: result.status,
    callsId: result.callsId,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}

function recordFrom(
  credential: PasskeyCredential,
  walletAddress: Address,
  rpId: string,
  label?: string,
): StoredPasskey {
  if (credential.kind !== "webauthn") {
    throw new Error("Altana returned a headless credential; that is a test-only signer.");
  }
  return fromAltanaCredential(credential, walletAddress, {
    rpId: credential.rpId ?? rpId,
    ...(label ? { label } : {}),
  });
}
