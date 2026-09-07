/**
 * Resumable spike state.
 *
 * Holds PUBLIC data only — addresses, public keys, tx hashes, step outcomes.
 * Secrets live in `.env`. That split is what makes the step 6 server-death
 * drill honest: the drill reads its inputs from here, so it structurally
 * cannot reach the agent's session key.
 *
 * Resumption is the dangerous part. "Step 6 already passed" is a claim about a
 * specific owner on a specific network; replaying it against a different owner
 * would skip a revocation that never happened for that key. The state file is
 * therefore partitioned by network AND bound to the owner it was written for,
 * and a mismatch is fatal rather than merely noted.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Address, Hex } from "viem";

/** Which chain a run targets. Resolved once, in `network.ts`. */
export type SpikeNetworkName = "mainnet" | "testnet";

export type StepStatus = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

export type StepRecord = {
  status: StepStatus;
  note: string;
  evidence: string[];
  at: string;
};

/** Public session facts. Sufficient to revoke; useless for signing. */
export type SessionFacts = {
  publicKey: Hex;
  address: Address;
  expiresAt: number;
  allowedTarget: Address;
  capWei: string;
  capPeriod: string;
};

export type SpikeState = {
  ownerAddress?: Address;
  walletAddress?: Address;
  naiveAgentWalletAddress?: Address;
  session?: SessionFacts;
  steps: Record<string, StepRecord>;
};

export type OpenStateOptions = {
  readonly network: SpikeNetworkName;
  /**
   * The owner this run is acting for. A persisted state file written for a
   * different owner is rejected outright.
   */
  readonly ownerAddress: Address;
  /** Directory holding the state file. Injectable for tests. */
  readonly directory?: URL;
};

/**
 * A state file plus the operations the spike performs on it.
 *
 * Bundled so no call site can record a step into a file other than the one it
 * loaded — the previous free-function shape read `SPIKE_NETWORK` in one module
 * and the network config in another, which is exactly how a mainnet run ends
 * up writing testnet state.
 */
export type SpikeStateStore = {
  readonly path: URL;
  readonly state: SpikeState;
  save(): void;
  isDone(step: string): boolean;
  record(
    step: string,
    status: StepStatus,
    note: string,
    evidence?: string[],
  ): void;
};

const DEFAULT_DIRECTORY = new URL("../../", import.meta.url);

/** One state file per network, so a testnet run never masks a mainnet run. */
export function stateFilePath(
  network: SpikeNetworkName,
  directory: URL = DEFAULT_DIRECTORY,
): URL {
  const suffix = network === "mainnet" ? ".mainnet" : "";
  return new URL(`.spike-state${suffix}.json`, directory);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Case-insensitive address comparison; state files are hand-editable. */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Read a state file. A corrupt or unreadable file yields a fresh state rather
 * than wedging the spike — the file is a cache of verdicts, not a source of
 * truth about the chain.
 */
export function readState(path: URL): SpikeState {
  if (!existsSync(path)) return { steps: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { steps: {} };
    const steps = isRecord(parsed["steps"])
      ? (parsed["steps"] as Record<string, StepRecord>)
      : {};
    return { ...(parsed as SpikeState), steps };
  } catch {
    return { steps: {} };
  }
}

export function writeState(state: SpikeState, path: URL): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Open the state file for this network and bind it to `ownerAddress`.
 *
 * Throws when the file was written for a different owner. Deleting the file is
 * the operator's explicit choice to make; guessing on their behalf would mean
 * replaying "already revoked" against a key that never was.
 */
export function openSpikeState(options: OpenStateOptions): SpikeStateStore {
  const path = stateFilePath(options.network, options.directory);
  const state = readState(path);

  const persistedOwner = state.ownerAddress;
  if (
    persistedOwner !== undefined &&
    !sameAddress(persistedOwner, options.ownerAddress)
  ) {
    throw new Error(
      `Spike state at ${path.pathname} belongs to owner ${persistedOwner}, but this run is acting for ${options.ownerAddress}. Resuming would replay another key's verdicts. Delete the file or point SPIKE_OWNER_KEY_VAR at the original key.`,
    );
  }
  state.ownerAddress = options.ownerAddress;

  const store: SpikeStateStore = {
    path,
    state,
    save(): void {
      writeState(state, path);
    },
    isDone(step: string): boolean {
      return state.steps[step]?.status === "PASS";
    },
    record(step, status, note, evidence = []): void {
      state.steps[step] = {
        status,
        note,
        evidence,
        at: new Date().toISOString(),
      };
      writeState(state, path);
    },
  };

  store.save();
  return store;
}
