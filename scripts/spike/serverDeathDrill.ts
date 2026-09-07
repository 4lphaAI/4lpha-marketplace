/**
 * Step 6 / step 8: the server-death drill.
 *
 * PREMISE: 4lpha's servers are gone. The agent runtime is gone. The session
 * private key is gone with it. The Altana relay may also be gone. All the user
 * has is their own private key, this chain's public RPC, and whatever public
 * data they can read on-chain.
 *
 * The module boundary is the proof. `DrillInputs` carries no session signer,
 * no relay client, and no provider-issued handle — only the owner's key and
 * PUBLIC identifiers for the session being killed. There is no parameter
 * through which the agent key could reach this code, so a reader does not have
 * to trust a comment that says "we didn't use it".
 *
 * Everything here runs through viem against a public RPC. The Altana SDK is
 * intentionally not imported.
 */
import type { Address, Hex } from "viem";
import {
  AltanaProvider,
  ownerAuthorityFromPrivateKey,
  type OwnerRevokeSessionDirectResult,
} from "../../src/wallet/altana.js";
import type { AgentWalletRef, ExecutionReceipt } from "../../src/core/types.js";

/**
 * Inputs available to a user whose provider has vanished.
 *
 * `sessionAddress` and `sessionPublicKey` are public on-chain identifiers,
 * readable from `IthacaAccount.getKeys()` or the KeyStore registry. Knowing
 * them confers no ability to sign.
 */
export type DrillInputs = {
  /** The user's own key. In production this never leaves their device. */
  readonly ownerPrivateKey: Hex;
  readonly walletAddress: Address;
  readonly chainId: number;
  /** Public identifier of the session key to kill. */
  readonly sessionAddress: Address;
  /** Public identifier the KeyStore registry indexes by. */
  readonly sessionPublicKey: Hex;
};

/**
 * The provider's own result, unmodified.
 *
 * It already carries the post-revocation read-back and the `revoked` verdict
 * derived from it. Re-deriving that here — "confirmed plus not registered
 * equals success" — is how two call sites end up disagreeing about whether a
 * kill switch fired.
 */
export type RevokeDrillResult = OwnerRevokeSessionDirectResult;

function walletRef(inputs: DrillInputs, ownerAddress: Address): AgentWalletRef {
  return {
    address: inputs.walletAddress,
    chainId: inputs.chainId,
    ownerAddress,
    custodyModel: "self-eoa",
  };
}

/**
 * Kill the session with the owner key alone, without the Altana relay.
 *
 * Two owner-originated transactions:
 *   1. self-call `IthacaAccount.revoke(keyHash)` — strips any account-level
 *      entry. Passes the account's `onlyThis` gate because under EIP-7702 the
 *      account address IS the owner's EOA. On Altana it usually reverts
 *      `KeyDoesNotExist()`, since sessions are not registered there.
 *   2. `AltanaKeyStore.revokeKey(wallet, keyId)` — the registry that actually
 *      carries session authority. This is the leg that must land.
 *
 * `result.revoked` is the verdict, read back from chain state.
 */
export async function revokeWithOwnerKeyOnly(
  provider: AltanaProvider,
  inputs: DrillInputs,
): Promise<RevokeDrillResult> {
  const owner = ownerAuthorityFromPrivateKey(inputs.ownerPrivateKey);
  return provider.ownerRevokeSessionDirect({
    wallet: walletRef(inputs, owner.address),
    owner,
    sessionAddress: inputs.sessionAddress,
    sessionPublicKey: inputs.sessionPublicKey,
  });
}

/**
 * Sweep every remaining native token out of the wallet, with the owner key
 * alone. `to` defaults to the owner's own address.
 */
export async function withdrawWithOwnerKeyOnly(
  provider: AltanaProvider,
  inputs: DrillInputs,
  to?: Address,
): Promise<ExecutionReceipt> {
  const owner = ownerAuthorityFromPrivateKey(inputs.ownerPrivateKey);
  return provider.ownerRecoverNative({
    wallet: walletRef(inputs, owner.address),
    owner,
    to: to ?? owner.address,
  });
}
