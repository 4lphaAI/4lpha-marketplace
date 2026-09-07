/**
 * Offline tests for the pre-flight on `executeViaSession` / `preflightExecute`.
 *
 * These are cost controls, not security controls — the account contract is what
 * enforces the policy. They exist because an execute that the chain will
 * reject still costs a relay round trip, and an expired session fails only
 * after the SDK has spent tens of seconds polling for a key that will never be
 * valid (FINDINGS.md (f)).
 *
 * ─── WHY THERE IS A SCRIPTED NODE HERE NOW (PHASE2.4 R4 item 15) ────────────
 *
 * The pre-flight no longer stops at the granted snapshot. When the snapshot
 * refuses, it asks the ACCOUNT whether it would allow the call anyway (D1), so
 * every rejection case below now runs through that fallback and every one of
 * them needs the chain scripted to REFUSE — otherwise the test would be
 * asserting a refusal it got by being unable to reach an RPC, which is the same
 * green for the wrong reason. `calls` counts every `eth_call` the provider made,
 * so the cases that must NOT reach the chain can say so.
 *
 * No test in this file opens a socket: the transport is injected.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  custom,
  encodeAbiParameters,
  getAddress,
  numberToHex,
  toFunctionSelector,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BNB_TESTNET, type Client as AltanaClient } from "@altananetwork/sdk";
import {
  AltanaProvider,
  MAX_CALLS_PER_EXECUTE,
  accountKeyHashForAddress,
  authorityFromPrivateKey,
} from "../src/wallet/altana.js";
import type { SessionRef, SessionSpec } from "../src/core/types.js";

const TARGET = getAddress("0x000000000000000000000000000000000000dEaD");
const OTHER = getAddress("0x00000000000000000000000000000000000d3ad1");
const WALLET = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");

/** A real key, so `publicKeyToAddress` and the key-hash derivation both work. */
const SESSION_PK = `0x${"5e".repeat(32)}` as Hex;
const SESSION_ACCOUNT = privateKeyToAccount(SESSION_PK);
const SESSION_KEY_HASH = accountKeyHashForAddress(SESSION_ACCOUNT.address);

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

/** `approve(address,uint256)` — a VALUE-MOVING selector, so the fallback must
 * answer both halves for it (R5). */
const APPROVE = toFunctionSelector("approve(address,uint256)");

function sessionRef(spec: Partial<SessionSpec> = {}): SessionRef {
  return {
    walletAddress: WALLET,
    chainId: BNB_TESTNET.chainId,
    publicKey: SESSION_ACCOUNT.publicKey,
    spec: {
      allowedCalls: [{ to: TARGET }],
      spendCaps: [{ limit: 1n, period: "hour" }],
      expiresAt: FUTURE,
      ...spec,
    },
    // Deliberately not a real handle: if a guard ever stops firing, the call
    // fails here rather than reaching the relay from a test run.
    handle: {},
  };
}

/* -------------------------------------------------------------------------- */
/* The scripted account                                                       */
/* -------------------------------------------------------------------------- */

const SELECTORS = {
  getKeys: toFunctionSelector("getKeys()"),
  canExecute: toFunctionSelector("canExecute(bytes32,address,bytes)"),
  spendInfos: toFunctionSelector("spendInfos(bytes32)"),
} as const;

/** A coded JSON-RPC error, so viem does not retry with slow backoff. */
class RpcError extends Error {
  readonly code: number;
  constructor(message: string, code = -32000) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

type AccountScript = {
  /** What `canExecute` answers. Defaults to REFUSE. */
  readonly canExecute?: boolean | ((target: Address) => boolean);
  /** Whether the account reports this key as super-admin. */
  readonly superAdmin?: boolean;
  /** Whether the key hash appears in `getKeys()` at all. */
  readonly registered?: boolean;
  /** Tokens `spendInfos` reports a positive limit for. */
  readonly spendLimits?: readonly Address[];
  /** Make every read revert, the way a dead endpoint would. */
  readonly failCalls?: boolean;
  /**
   * Make every read fail with THIS error instead of a revert
   * (PHASE3.1-FIXREVIEW F1). A revert and a dropped connection are different
   * facts and the pre-flight must stop reporting them as the same refusal.
   */
  readonly callError?: Error;
  /** Never answer at all, so `withDeadline` is what ends the read. */
  readonly hangCalls?: boolean;
};

type ScriptedNode = {
  readonly transport: (rpcUrl: string) => Transport;
  /** Every `eth_call` the provider made, by 4-byte selector. */
  readonly calls: string[];
};

function encodeKeys(script: AccountScript): Hex {
  const registered = script.registered ?? true;
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { type: "uint40" },
          { type: "uint8" },
          { type: "bool" },
          { type: "bytes" },
        ],
      },
      { type: "bytes32[]" },
    ],
    registered
      ? [
          [[FUTURE, 2, script.superAdmin ?? false, SESSION_ACCOUNT.publicKey]],
          [SESSION_KEY_HASH],
        ]
      : [[], []],
  );
}

function encodeSpendInfos(script: AccountScript): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { type: "address" },
          { type: "uint8" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
        ],
      },
    ],
    [
      (script.spendLimits ?? []).map((token) => [
        token,
        2,
        2n ** 160n,
        0n,
        0n,
        0n,
        2n ** 160n,
      ]) as [Address, number, bigint, bigint, bigint, bigint, bigint][],
    ],
  );
}

function scriptedAccount(script: AccountScript = {}): ScriptedNode {
  const calls: string[] = [];
  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    if (method === "eth_chainId") return numberToHex(BNB_TESTNET.chainId);
    if (method === "eth_call") {
      const call = (params as readonly { to?: string; data?: Hex }[])[0];
      const data = call?.data ?? "0x";
      calls.push(data.slice(0, 10).toLowerCase());
      if (script.hangCalls === true) return new Promise<never>(() => {});
      if (script.callError !== undefined) throw script.callError;
      if (script.failCalls === true) throw new RpcError("execution reverted");
      if (data.startsWith(SELECTORS.getKeys)) return encodeKeys(script);
      if (data.startsWith(SELECTORS.spendInfos)) return encodeSpendInfos(script);
      if (data.startsWith(SELECTORS.canExecute)) {
        // `canExecute(bytes32 keyHash, address target, bytes data)` — the target
        // is the second word, so a script can answer per target.
        const target = getAddress(`0x${data.slice(10 + 64 + 24, 10 + 128)}`);
        const answer = script.canExecute ?? false;
        const allowed = typeof answer === "function" ? answer(target) : answer;
        return `0x${(allowed ? 1 : 0).toString(16).padStart(64, "0")}`;
      }
      throw new RpcError(`unscripted eth_call ${data.slice(0, 10)}`);
    }
    throw new RpcError(`unscripted method ${method}`, -32601);
  };
  return { transport: () => custom({ request }), calls };
}

function providerFor(node: ScriptedNode): AltanaProvider {
  return new AltanaProvider({ network: BNB_TESTNET, transport: node.transport });
}

function call(to: Address): { to: Address; value: bigint } {
  return { to, value: 1n };
}

/* -------------------------------------------------------------------------- */
/* The snapshot half                                                          */
/* -------------------------------------------------------------------------- */

describe("executeViaSession pre-flight", () => {
  it("rejects an empty batch", async () => {
    const node = scriptedAccount();
    await assert.rejects(
      providerFor(node).executeViaSession({ session: sessionRef(), calls: [] }),
      /at least one call/i,
    );
    assert.equal(node.calls.length, 0, "a malformed batch asks nobody anything");
  });

  it("rejects a batch larger than the ceiling", async () => {
    const node = scriptedAccount();
    const calls = Array.from({ length: MAX_CALLS_PER_EXECUTE + 1 }, () => call(TARGET));

    await assert.rejects(
      providerFor(node).executeViaSession({ session: sessionRef(), calls }),
      new RegExp(`at most ${MAX_CALLS_PER_EXECUTE} calls`),
    );
    assert.equal(node.calls.length, 0);
  });

  it("accepts a batch exactly at the ceiling", async () => {
    const node = scriptedAccount();
    const calls = Array.from({ length: MAX_CALLS_PER_EXECUTE }, () => call(TARGET));

    // Passes the guards and fails on the stub handle, which is the marker for
    // "it got as far as submission".
    await assert.rejects(
      providerFor(node).executeViaSession({ session: sessionRef(), calls }),
      /Session handle was not created by this provider/,
    );
    assert.equal(
      node.calls.length,
      0,
      "a batch the snapshot already permits must cost NO chain read",
    );
  });

  it("rejects an expired session without a relay round trip OR a chain read", async () => {
    // Expiry is checked locally and FIRST (D1 rule 4). It is enforced on chain,
    // so asking the account about a dead session would only pay to be told so.
    const node = scriptedAccount({ canExecute: true });
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
        calls: [call(TARGET)],
      }),
      (error: unknown) =>
        error instanceof Error && error.name === "SessionExpiredError",
    );
    assert.equal(node.calls.length, 0, "an expired session asks the chain nothing");
  });

  it("rejects a target outside the allowlist when the chain also refuses", async () => {
    const node = scriptedAccount({ canExecute: false });
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef(),
        calls: [call(OTHER)],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
    assert.ok(node.calls.length > 0, "the refused call must have been put to the chain");
  });

  it("matches allowlist targets regardless of checksum casing", async () => {
    const node = scriptedAccount();
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef(),
        calls: [call(TARGET.toLowerCase() as Address)],
      }),
      /Session handle was not created by this provider/,
    );
    assert.equal(node.calls.length, 0);
  });

  /*
   * The bare-selector cases below used `transfer(address,uint256)` until
   * PHASE2.3 R2, which refuses a bare-selector VALUE-MOVING rule at validation
   * regardless of `allowUnrestrictedSelector` — so a spec shaped like that can
   * no longer be granted, and a pre-flight test built on one would be pinning
   * an unreachable state. They now use `deposit()`, which is what the opt-in
   * still legitimately expresses: a non-value-moving function on any target.
   */

  it("a bare-selector rule does not disable the check for other calls", async () => {
    // PHASE2 R1 / review F1. This test USED to assert the opposite, encoding the
    // bug: one rule without a `to` made the pre-flight return early, so every
    // call in the batch went through unchecked. A value transfer carries no
    // selector, so no rule here can permit it.
    const node = scriptedAccount({ canExecute: false });
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef({
          allowedCalls: [{ to: TARGET }, { selector: "deposit()" }],
          allowUnrestrictedSelector: true,
        }),
        calls: [call(OTHER)],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
  });

  it("a bare-selector rule permits exactly the calldata it names", async () => {
    // `deposit()` = 0xd0e30db0, computed independently of viem.
    const node = scriptedAccount();
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef({
          allowedCalls: [{ selector: "deposit()" }],
          allowUnrestrictedSelector: true,
        }),
        calls: [{ to: OTHER, data: `0xd0e30db0${"00".repeat(64)}` }],
      }),
      /Session handle was not created by this provider/,
      "a selector rule must MATCH the call's first four bytes, not be ignored",
    );
    assert.equal(node.calls.length, 0);
  });

  it("a bare-selector rule rejects a different function on any target", async () => {
    const node = scriptedAccount({ canExecute: false });
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef({
          allowedCalls: [{ selector: "deposit()" }],
          allowUnrestrictedSelector: true,
        }),
        // `withdraw(uint256)` = 0x2e1a7d4d.
        calls: [{ to: OTHER, data: `0x2e1a7d4d${"00".repeat(64)}` }],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
  });

  it("a to+selector rule requires BOTH to match", async () => {
    const node = scriptedAccount({ canExecute: false });
    const provider = providerFor(node);
    const spec = {
      allowedCalls: [{ to: TARGET, selector: "transfer(address,uint256)" }],
      spendCaps: [{ limit: 1n, period: "hour" as const, token: TARGET }],
    };
    // Right target, wrong function.
    await assert.rejects(
      provider.executeViaSession({
        session: sessionRef(spec),
        calls: [{ to: TARGET, data: `0x095ea7b3${"00".repeat(64)}` }],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
    // Right function, wrong target.
    await assert.rejects(
      provider.executeViaSession({
        session: sessionRef(spec),
        calls: [{ to: OTHER, data: `0xa9059cbb${"00".repeat(64)}` }],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
    // Both right: reaches the stub handle.
    await assert.rejects(
      provider.executeViaSession({
        session: sessionRef(spec),
        calls: [{ to: TARGET, data: `0xa9059cbb${"00".repeat(64)}` }],
      }),
      /Session handle was not created by this provider/,
    );
  });

  it("submits anyway when the caller bypasses the local check", async () => {
    // The spike sets this to prove the CHAIN rejects an out-of-scope call.
    const node = scriptedAccount({ canExecute: false });
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
        calls: [call(OTHER)],
        bypassLocalPolicyCheck: true,
      }),
      /Session handle was not created by this provider/,
    );
    assert.equal(node.calls.length, 0, "a bypass asks nobody anything");
  });

  it("still refuses a malformed batch under a bypass", async () => {
    const node = scriptedAccount();
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef(),
        calls: [],
        bypassLocalPolicyCheck: true,
      }),
      /at least one call/i,
    );
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef(),
        calls: Array.from({ length: MAX_CALLS_PER_EXECUTE + 1 }, () => call(TARGET)),
        bypassLocalPolicyCheck: true,
      }),
      new RegExp(`at most ${MAX_CALLS_PER_EXECUTE} calls`),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The chain fallback (PHASE2.4 D1 / R1 / R5)                                 */
/* -------------------------------------------------------------------------- */

describe("preflightExecute: the chain fallback", () => {
  it("submits when the snapshot refuses and the account allows every call", async () => {
    // FINDINGS (v): the owner authorised the token on chain AFTER the grant, so
    // the snapshot can never agree and nothing the owner does could lift it.
    const node = scriptedAccount({ canExecute: true });
    await assert.rejects(
      providerFor(node).executeViaSession({
        session: sessionRef(),
        calls: [call(OTHER)],
      }),
      /Session handle was not created by this provider/,
      "an account-authorised call must reach submission",
    );
  });

  it("refuses when the chain allows one call of several and refuses another", async () => {
    const node = scriptedAccount({ canExecute: (target) => target === OTHER });
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef(),
        calls: [call(OTHER), call(getAddress("0x00000000000000000000000000000000000d3ad2"))],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
  });

  it("refuses, sanitised, when the chain read throws", async () => {
    // Degraded reach, never degraded safety. The upstream prose never travels.
    const node = scriptedAccount({ failCalls: true });
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef(),
        calls: [call(OTHER)],
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "NotAllowedError" &&
        /not in the session allowlist/.test(error.message) &&
        !/revert/i.test(error.message),
    );
  });

  it("PHASE3.1-FIXREVIEW F1: an RPC OUTAGE in the fallback is an outage, not a policy refusal", async () => {
    // THE FINDING. `#chainWouldAllow` swallowed every throw and answered
    // `false`, so the caller minted a `NotAllowedError` — "your call is not in
    // the session allowlist" — out of a dropped connection. An outage wearing a
    // rejection's clothes, upstream of `mapProviderError`, where no downstream
    // classifier could ever repair it. Every caller that retries transient
    // failures (the LP exit's optional step above all) therefore saw a
    // permanent policy verdict.
    //
    // The REFUSAL is unchanged — nothing is submitted, the fallback still fails
    // closed — but the class it carries is now true.
    for (const message of ["socket hang up", "read ECONNRESET", "fetch failed"]) {
      const node = scriptedAccount({ callError: new RpcError(message) });
      await assert.rejects(
        providerFor(node).preflightExecute({
          session: sessionRef(),
          calls: [call(OTHER)],
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === "InfrastructureError" &&
          !/not in the session allowlist/.test(error.message),
        `${message} still presented as a policy refusal`,
      );
    }
  });

  it("PHASE3.1-FIXREVIEW F1: a fallback TIMEOUT is an outage too", async () => {
    // The path the reviewer traced by name: `withDeadline` rejects, the catch
    // swallowed it, and `preflightExecute` answered NOT_ALLOWED. This exercises
    // the real deadline (PREFLIGHT_CHAIN_TIMEOUT_MS) rather than simulating it,
    // because the swallow and the deadline's own error class were two separate
    // halves of the same lie.
    const node = scriptedAccount({ hangCalls: true });
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef(),
        calls: [call(OTHER)],
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "InfrastructureError" &&
        /timed out/i.test(error.message) &&
        !/not in the session allowlist/.test(error.message),
    );
  });

  it("PHASE3.1-FIXREVIEW F1: a DETERMINATE no is still NOT_ALLOWED", async () => {
    // The counter-case, and the reason the substitution is narrow: when the
    // account was actually asked and actually declined, nothing about that is
    // transient and the refusal must keep saying so. Same for a read that
    // REVERTED — a revert is an answer, not a dropped connection, which is why
    // the pre-existing `failCalls` case above still expects NotAllowedError.
    const node = scriptedAccount({ canExecute: false });
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef(),
        calls: [call(OTHER)],
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "NotAllowedError" &&
        /not in the session allowlist/.test(error.message),
    );
  });

  it("PHASE3.1-FIXREVIEW3 H4: a read that REVERTED still refuses, even carrying transport words", async () => {
    // The second half of G2's behaviour, and the half `failCalls` above could not
    // pin: its revert message (`execution reverted`) carries no transport
    // vocabulary, so it passed both before and after `REVERT_EVIDENCE` existed.
    // These three DO carry it. Without the gate, `\b(?:timed ?out|timeout)\b` /
    // `ETIMEDOUT` / `\bnetwork (?:error|failure)\b` win, the cause classifies
    // INFRASTRUCTURE, and this fallback re-throws it — reporting a DETERMINATE
    // on-chain answer as an outage, which is the substitution's own stated
    // boundary running backwards ("a revert is an answer, not a dropped
    // connection"). Every one of them must still be the allowlist refusal.
    for (const message of [
      "execution reverted: Timeout()",
      "execution reverted; ETIMEDOUT",
      'The contract function "canExecute" reverted with the following reason: network error',
    ]) {
      const node = scriptedAccount({ callError: new RpcError(message) });
      await assert.rejects(
        providerFor(node).preflightExecute({
          session: sessionRef(),
          calls: [call(OTHER)],
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === "NotAllowedError" &&
          /not in the session allowlist/.test(error.message) &&
          !/revert/i.test(error.message),
        `${message} was reported as an outage; a revert is an answer`,
      );
    }
  });

  it("VOIDS the fallback for a super-admin key", async () => {
    // FINDINGS (o), `SuperAdminCanExecuteEverything`: such a key answers `true`
    // to everything, so honouring the verdict would not widen the pre-flight —
    // it would delete it.
    const node = scriptedAccount({ canExecute: true, superAdmin: true });
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef(),
        calls: [call(OTHER)],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
  });

  it("refuses when the key is not on the account at all", async () => {
    const node = scriptedAccount({ canExecute: true, registered: false });
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef(),
        calls: [call(OTHER)],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
  });

  it("refuses a call back into the WALLET even when the account allows it", async () => {
    // R1: 4lpha's own policy, layered on top of the chain's. `canExecute` knows
    // nothing about it, and one owner self-call would make the account say yes.
    const node = scriptedAccount({ canExecute: true });
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef(),
        calls: [call(WALLET)],
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "NotAllowedError" &&
        /wallet itself/.test(error.message),
    );
    assert.equal(node.calls.length, 0, "a structural refusal is never put to the chain");
  });

  it("refuses a call into the KEYSTORE even when the account allows it", async () => {
    const node = scriptedAccount({ canExecute: true });
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef(),
        calls: [call(getAddress(BNB_TESTNET.keyStore))],
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "NotAllowedError" &&
        /key registry/.test(error.message),
    );
    assert.equal(node.calls.length, 0);
  });

  it("requires BOTH halves for a value-moving selector", async () => {
    // R5 / FINDINGS (u). The allowlist alone is the trap that stranded a live
    // position: the account checks it FIRST, so a token with an `approve` entry
    // and no spend limit passes every allowlist read and still cannot be sold.
    const withoutLimit = scriptedAccount({ canExecute: true, spendLimits: [] });
    await assert.rejects(
      providerFor(withoutLimit).preflightExecute({
        session: sessionRef(),
        calls: [{ to: OTHER, data: `${APPROVE}${"00".repeat(64)}` as Hex }],
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );

    const withLimit = scriptedAccount({ canExecute: true, spendLimits: [OTHER] });
    await providerFor(withLimit).preflightExecute({
      session: sessionRef(),
      calls: [{ to: OTHER, data: `${APPROVE}${"00".repeat(64)}` as Hex }],
    });
  });

  it("reads spendInfos ONCE for the whole batch", async () => {
    // It is per-KEY, not per-call, so a three-call sell costs three `canExecute`
    // reads and one meter read — not four.
    const node = scriptedAccount({ canExecute: true, spendLimits: [OTHER] });
    await providerFor(node).preflightExecute({
      session: sessionRef(),
      calls: [
        { to: OTHER, data: `${APPROVE}${"00".repeat(64)}` as Hex },
        { to: OTHER, data: `${APPROVE}${"11".repeat(64)}` as Hex },
        call(OTHER),
      ],
    });
    const meterReads = node.calls.filter(
      (selector) => selector === SELECTORS.spendInfos,
    ).length;
    const allowlistReads = node.calls.filter(
      (selector) => selector === SELECTORS.canExecute,
    ).length;
    assert.equal(meterReads, 1);
    assert.equal(allowlistReads, 3);
  });

  it("still throws from INSIDE the submit when execute resolves and the signal then aborts", async () => {
    // PHASE2.4 R4 item 16, and the hazard the positional split exists for. The
    // abort helper runs on BOTH sides of `#client.execute`, so the two throws
    // are indistinguishable by type — the only thing that tells them apart is
    // WHERE they happen. Here the submit has already been accepted, so the
    // throw must come out of `executeViaSession` (which the routes wrap in the
    // ambiguous block and journal UNKNOWN) and never out of `preflightExecute`.
    const controller = new AbortController();
    const provider = new AltanaProvider({
      network: BNB_TESTNET,
      transport: scriptedAccount({ canExecute: true }).transport,
      client: {
        execute: async () => {
          // The relay has it. Anything after this line is ambiguous.
          controller.abort();
          return { status: "CONFIRMED", callsId: `0x${"cc".repeat(32)}` };
        },
      } as unknown as AltanaClient,
    });
    const spec = sessionRef().spec;
    const session = provider.restoreSession({
      spec,
      agent: authorityFromPrivateKey(SESSION_PK),
      walletAddress: WALLET,
      publicKey: SESSION_ACCOUNT.publicKey,
      expiresAt: spec.expiresAt,
    });

    // The pre-flight passed BEFORE the abort: a live signal, a granted target.
    await provider.preflightExecute({ session, calls: [call(TARGET)], signal: controller.signal });

    await assert.rejects(
      provider.executeViaSession({
        session,
        calls: [call(TARGET)],
        signal: controller.signal,
      }),
      /aborted by caller/i,
    );
  });

  it("refuses on an aborted signal without asking the chain", async () => {
    // An abort means REFUSE here and ONLY here: nothing has been submitted, so
    // "we stopped asking" is honestly a refusal. It is never a refusal on the
    // submit path, where it cannot prove the request did not land.
    const node = scriptedAccount({ canExecute: true });
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef(),
        calls: [call(OTHER)],
        signal: AbortSignal.abort(),
      }),
      (error: unknown) => error instanceof Error && error.name === "NotAllowedError",
    );
    assert.equal(node.calls.length, 0);
  });
});
