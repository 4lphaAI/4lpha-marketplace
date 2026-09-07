import { describe, expect, it } from "vitest";
import {
  EMPTY_REMOVE_PROGRESS,
  newRemoveAttempt,
  nextRemoveStep,
  removeAttemptBindings,
  type RemoveSnapshot,
} from "./remove-agent";

const NOW = 2_000_000;
const base: RemoveSnapshot = {
  status: "paused",
  positions: [],
  sequences: [],
  sessionRegistration: null,
  finalizedSessionRevocation: null,
};

describe("LP Remove matrix", () => {
  it("blocks an in-flight open arm and makes a held arm explicitly abandonable", () => {
    const active = nextRemoveStep({ ...base, sequences: [{ sequenceId: "open", positionId: "p", kind: "open", state: "active", recoveryState: "none" }] }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(active).toMatchObject({ kind: "blocked", blocker: { abandonable: false, kind: "open" } });
    const held = nextRemoveStep({ ...base, sequences: [{ sequenceId: "open", positionId: "p", kind: "open", state: "held", recoveryState: "pending-mint" }] }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(held).toMatchObject({ kind: "blocked", blocker: { abandonable: true, kind: "open" } });
  });

  it("accepts a closed never-funded row and serializes live exits before revoke and proof", () => {
    const closed = { positionId: "never-funded", state: "closed" };
    expect(nextRemoveStep({ ...base, positions: [closed] }, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("local-revoke");

    const first = nextRemoveStep({ ...base, positions: [closed, { positionId: "nft-a", state: "open" }, { positionId: "nft-b", state: "closing" }] }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(first).toMatchObject({ kind: "exit", positionId: "nft-a" });
    const second = nextRemoveStep({ ...base, positions: [closed, { positionId: "nft-a", state: "closed" }, { positionId: "nft-b", state: "closing" }] }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(second).toMatchObject({ kind: "exit", positionId: "nft-b" });
    expect(nextRemoveStep({ ...base, positions: [closed], status: "paused" }, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("local-revoke");
    expect(nextRemoveStep({ ...base, positions: [closed], status: "revoked" }, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("broadcast-revoke");
    expect(nextRemoveStep({ ...base, positions: [closed], status: "revoked",
      finalizedSessionRevocation: { kind: "missing", checkedAtMs: NOW } }, EMPTY_REMOVE_PROGRESS, NOW).kind).toBe("removed");
  });

  it("treats an on-chain NFT disagreement represented by a still-live row as unfinished", () => {
    const decision = nextRemoveStep({ ...base, status: "revoked", positions: [{ positionId: "nft-disagrees", state: "open" }] }, EMPTY_REMOVE_PROGRESS, NOW);
    expect(decision.kind).toBe("blocked");
    expect(decision.message).toContain("still has live position");
  });

  it("executes the serial LP plan as exit, exit, local revoke, broadcast, proof, removed", async () => {
    let snapshot: RemoveSnapshot = {
      ...base,
      positions: [
        { positionId: "nft-a", state: "open" },
        { positionId: "nft-b", state: "closing" },
      ],
    };
    let progress = EMPTY_REMOVE_PROGRESS;
    const effects: string[] = [];
    for (;;) {
      const decision = nextRemoveStep(snapshot, progress, NOW);
      effects.push(decision.kind === "exit" ? `exit:${decision.positionId}` : decision.kind);
      if (decision.kind === "exit") {
        await Promise.resolve();
        snapshot = {
          ...snapshot,
          positions: snapshot.positions.map((position) => position.positionId === decision.positionId
            ? { ...position, state: "closed" as const }
            : position),
        };
      } else if (decision.kind === "local-revoke") {
        await Promise.resolve();
        snapshot = { ...snapshot, status: "revoked" };
      } else if (decision.kind === "broadcast-revoke") {
        await Promise.resolve();
        const bindings = removeAttemptBindings({
          ownerAddress: "0x1111111111111111111111111111111111111111",
          agentId: "lp-agent",
          walletAddress: "0x2222222222222222222222222222222222222222",
          sessionPublicKey: `0x04${"33".repeat(64)}`,
        });
        if (bindings === null) throw new Error("invalid fixture bindings");
        progress = {
          revokeAttempt: {
            ...newRemoveAttempt(bindings, "123e4567-e89b-42d3-a456-426614174000", NOW),
            state: "pending",
            callsId: "0x1234",
          },
        };
      } else if (decision.kind === "check-revoke") {
        await Promise.resolve();
        snapshot = {
          ...snapshot,
          finalizedSessionRevocation: { kind: "missing", checkedAtMs: NOW },
        };
      } else if (decision.kind === "removed") {
        break;
      } else {
        throw new Error(`Unexpected remove decision ${decision.kind}`);
      }
    }
    expect(effects).toEqual([
      "exit:nft-a",
      "exit:nft-b",
      "local-revoke",
      "broadcast-revoke",
      "check-revoke",
      "removed",
    ]);
  });
});
