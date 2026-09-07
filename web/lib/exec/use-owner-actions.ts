"use client";

/**
 * React glue between the owner credential and the owner-action wire shapes.
 * The credential signs; the BFF only forwards. Mutations are posted with the
 * exact JSON bytes whose `params` the signature covers.
 *
 * TWO CREDENTIALS, ONE SEAM. A stored WebAuthn passkey wins over the connected
 * wallet, because under the marketplace's custody model the passkey IS the owner
 * identity (memory: owner-identity-is-the-passkey) and MetaMask is only a
 * funding source. The plane dispatches on signature size — 65 bytes is
 * secp256k1, anything else is the WebAuthn envelope — so the same routes accept
 * both without a scheme field.
 *
 * `ownerAddress` under passkey mode is a DERIVED IDENTITY, never an account:
 * value sent there is burned, and no surface may render it as a deposit target.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { subscribeAccountNavigation } from "./account-switch";
import { useAccount, useSignTypedData } from "wagmi";
import {
  buildOwnerAction,
  encodeReadHeader,
  execDomainConfigFromEnv,
  type OwnerActionEnvelope,
} from "./owner-action";
import {
  forgetStoredPasskey,
  activePasskeyGuard,
  loadStoredPasskey,
  ownerAddressFromPasskey,
  passkeyRpId,
  signOwnerActionWithPasskey,
  storePasskey,
  subscribeToPasskey,
  type StoredPasskey,
} from "./passkey";

/**
 * The Altana SDK is loaded LAZILY, at the moment a wallet ceremony actually
 * runs. It drags porto and a relay client behind it, none of which a user who
 * only signs owner actions ever needs, and a static import would put all of it
 * in the first bundle every account page pulls. It also keeps this module
 * importable from a plain node test.
 */
async function altana() {
  return import("@/lib/altana/client");
}

export type OwnerKind = "passkey" | "wallet";

/**
 * `useSyncExternalStore` rather than an effect: the server render and the first
 * client render must agree, and localStorage is unreadable during the former.
 */
function useStoredPasskey(): StoredPasskey | null {
  return useSyncExternalStore(subscribeToPasskey, loadStoredPasskey, () => null);
}

export function useOwnerActions() {
  useEffect(() => subscribeAccountNavigation(), []);
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const passkey = useStoredPasskey();

  const ownerKind: OwnerKind = passkey ? "passkey" : "wallet";
  const ownerAddress = passkey
    ? ownerAddressFromPasskey(passkey.x, passkey.y)
    : address;

  const signEnvelope = useCallback(
    async (action: string, agentId: string, params: unknown): Promise<OwnerActionEnvelope> => {
      if (passkey) {
        const check = activePasskeyGuard(passkey);
        check();
        const envelope = await signOwnerActionWithPasskey({ credential: passkey, agentId, action, params });
        check();
        return envelope;
      }
      if (!address) throw new Error("Connect a wallet or create a passkey first.");
      const { signed, typedData } = buildOwnerAction({
        owner: address,
        agentId,
        action,
        params,
        domain: execDomainConfigFromEnv(),
      });
      const signature = await signTypedDataAsync(typedData);
      return { signed, signature, params };
    },
    [address, passkey, signTypedDataAsync],
  );

  /** One signed read header; reads never consume a nonce so it is retryable. */
  const signReadHeader = useCallback(
    async (agentId: string): Promise<string> => {
      const envelope = await signEnvelope("read", agentId, {});
      return encodeReadHeader(envelope);
    },
    [signEnvelope],
  );

  /**
   * "Use a passkey" is now Altana's ceremony (D1), not our raw one.
   *
   * ONE credential comes back and does both jobs: it is the admin key of the
   * new Altana wallet B, and its P256 public key derives our owner identity.
   * The record is stored WITH `walletAddress`, so a fresh user leaves this call
   * able to sign owner actions AND with somewhere to deposit.
   *
   * Nothing lands on chain here — the wallet is counterfactual until its first
   * admin action.
   */
  const createPasskey = useCallback(async (userName: string): Promise<StoredPasskey> => {
    const rpId = passkeyRpId();
    if (rpId === "") throw new Error("No relying-party id is configured for passkeys.");
    const record = await (await altana()).createPasskeyWallet({ name: "4lpha", rpId, label: userName });
    storePasskey(record);
    return record;
  }, []);

  /**
   * Rebuild `{ credential, walletAddress }` from the passkey alone (D2).
   *
   * This REPLACES whatever record this browser holds, because the credential
   * the user picks in the OS dialog is the authority on both halves. Only
   * finds wallets Altana's own ceremony created.
   */
  const recoverWallet = useCallback(async (): Promise<StoredPasskey> => {
    const rpId = passkeyRpId();
    if (rpId === "") throw new Error("No relying-party id is configured for passkeys.");
    const record = await (await altana()).recoverWalletFromPasskey({ rpId });
    storePasskey(record);
    return record;
  }, []);

  return {
    address,
    ownerAddress,
    ownerKind,
    passkey,
    /** Altana wallet B — payable. Distinct from `ownerAddress`, which is not. */
    walletAddress: passkey?.walletAddress,
    createPasskey,
    recoverWallet,
    forgetPasskey: forgetStoredPasskey,
    signEnvelope,
    signReadHeader,
  };
}
