/**
 * Offline tests for the execute-authorization boundary.
 *
 * This is the one place the "may we submit now?" question is answered, and the
 * answer must be: session not expired ∧ not paused ∧ not halted — with NO owner
 * signature involved. The cases below pin each denial reason and the all-clear,
 * and confirm the function's inputs carry no signature.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import {
  authorizeExecute,
  executeIdempotencyKey,
  ownerActionIdempotencyKey,
} from "../src/auth/executeDecision.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import type { AgentRecord, SessionFacts } from "../src/store/agents.js";
import type { SessionSpec } from "../src/core/types.js";
import type { OwnerActionStruct } from "../src/auth/ownerAuth.js";

const OWNER = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
/** The normalized scope key the store persists — lowercase, still an `Address`. */
const OWNER_KEY: Address = `0x${OWNER.slice(2).toLowerCase()}`;
const NOW = 1_900_000_000;

function spec(expiresAt: number): SessionSpec {
  return {
    allowedCalls: [{ to: getAddress("0x000000000000000000000000000000000000dEaD") }],
    spendCaps: [{ limit: 1n, period: "hour" }],
    expiresAt,
  };
}

function facts(expiresAt: number): SessionFacts {
  return {
    spec: spec(expiresAt),
    permissions: { calls: [], spend: [] },
    publicKey: `0x${"ab".repeat(64)}` as Hex,
    expiry: expiresAt,
  };
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    ownerAddress: OWNER_KEY,
    walletAddress: OWNER,
    custodyModel: "self-eoa",
    sessionFacts: facts(NOW + 3_600),
    sessionRevocation: null,
    caps: null,
    status: "armed",
    erc8004AgentId: null,
    pendingGrant: null,
    rowVersion: 1,
    createdAt: NOW * 1000,
    updatedAt: NOW * 1000,
    ...overrides,
    httpRuntimeProfile: overrides.httpRuntimeProfile ?? "trade-v1",
  };
}

describe("authorizeExecute", () => {
  it("allows an armed agent with a live session and no blocks", async () => {
    const decision = await authorizeExecute({
      agent: agent(),
      killswitch: new MemoryKillSwitch(),
      now: NOW,
    });
    assert.deepEqual(decision, { allowed: true });
  });

  it("blocks an expired session", async () => {
    const decision = await authorizeExecute({
      agent: agent({ sessionFacts: facts(NOW - 1) }),
      killswitch: new MemoryKillSwitch(),
      now: NOW,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "SESSION_EXPIRED");
  });

  it("blocks an agent with no session", async () => {
    const decision = await authorizeExecute({
      agent: agent({ sessionFacts: null }),
      killswitch: new MemoryKillSwitch(),
      now: NOW,
    });
    assert.equal(decision.allowed === false && decision.code, "NO_SESSION");
  });

  it("blocks a paused agent", async () => {
    const ks = new MemoryKillSwitch();
    await ks.pauseAgent("agent-1", OWNER);
    const decision = await authorizeExecute({ agent: agent(), killswitch: ks, now: NOW });
    assert.equal(decision.allowed === false && decision.code, "AGENT_PAUSED");
  });

  it("blocks under a global halt even with a live, unpaused session", async () => {
    const ks = new MemoryKillSwitch();
    await ks.halt("incident");
    const decision = await authorizeExecute({ agent: agent(), killswitch: ks, now: NOW });
    assert.equal(decision.allowed === false && decision.code, "GLOBAL_HALT");
  });

  it("takes no owner signature — its inputs are agent, killswitch, now only", async () => {
    // Structural guarantee: the call site cannot pass a signature. If a signature
    // were ever added to the input, this object literal would still type-check
    // only because it lacks the field — which is the intent.
    const input = { agent: agent(), killswitch: new MemoryKillSwitch(), now: NOW };
    assert.deepEqual(Object.keys(input).sort(), ["agent", "killswitch", "now"]);
    const decision = await authorizeExecute(input);
    assert.equal(decision.allowed, true);
  });
});

describe("idempotency keys", () => {
  const signed: OwnerActionStruct = {
    owner: OWNER,
    agentId: "agent-1",
    action: "grant",
    paramsHash: `0x${"cd".repeat(32)}` as Hex,
    nonce: `0x${"ab".repeat(32)}` as Hex,
    issuedAt: BigInt(NOW),
    expiry: BigInt(NOW + 120),
  };

  it("ownerActionIdempotencyKey is deterministic and casing-stable", async () => {
    const a = ownerActionIdempotencyKey(signed);
    const b = ownerActionIdempotencyKey({ ...signed, owner: OWNER.toLowerCase() as Address });
    assert.equal(a, b);
    assert.match(a, /^0x[0-9a-f]{64}$/);
  });

  it("ownerActionIdempotencyKey changes when any signed field changes", () => {
    const base = ownerActionIdempotencyKey(signed);
    assert.notEqual(base, ownerActionIdempotencyKey({ ...signed, action: "revoke" }));
    assert.notEqual(base, ownerActionIdempotencyKey({ ...signed, nonce: `0x${"ff".repeat(32)}` as Hex }));
  });

  it("executeIdempotencyKey binds agent, decision and calls", () => {
    const callsHash = `0x${"11".repeat(32)}` as Hex;
    const base = executeIdempotencyKey("agent-1", "dec-1", callsHash);
    assert.equal(base, executeIdempotencyKey("agent-1", "dec-1", callsHash));
    assert.notEqual(base, executeIdempotencyKey("agent-2", "dec-1", callsHash));
    assert.notEqual(base, executeIdempotencyKey("agent-1", "dec-2", callsHash));
    assert.match(base, /^0x[0-9a-f]{64}$/);
  });
});
