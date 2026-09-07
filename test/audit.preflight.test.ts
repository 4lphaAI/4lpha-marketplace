/**
 * AUDITOR-WRITTEN adversarial tests for PHASE2.4's pre-flight (R1, R3, R5).
 *
 * Written by the independent auditor, not by the implementer. They attack the
 * three properties the phase's whole safety argument rests on:
 *
 *   R1 — the two STRUCTURAL refusals (a call back into the wallet, a call into
 *        the KeyStore) hold unconditionally, ahead of the snapshot and ahead of
 *        the chain fallback, and cannot be talked out of by an address that is
 *        merely spelled differently;
 *   R3 — classification is POSITIONAL. The SAME error type is a rollback when it
 *        comes out of the pre-flight and an UNKNOWN when it comes out of the
 *        submit. A taxonomic rule would get this backwards, and backwards is a
 *        double spend;
 *   R5 — the fallback answers BOTH halves of a session for a value-moving call,
 *        whatever casing the calldata arrived in.
 *
 * Everything here is offline: the RPC transport is scripted and the SDK client
 * is never constructed.
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
import { BNB_TESTNET } from "@altananetwork/sdk";
import { AltanaProvider, accountKeyHashForAddress } from "../src/wallet/altana.js";
import { structuralTargetRefusal } from "../src/core/session.js";
import { NotAllowedError, type SessionRef, type SessionSpec } from "../src/core/types.js";
import {
  AGENT_ID,
  OWNER_ADDRESS,
  call as httpCall,
  createHarness,
  safeSecurityPayload,
  tradeBody,
  tradeConfig,
} from "./support/serverHarness.js";

const WALLET = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
const KEYSTORE = getAddress(BNB_TESTNET.keyStore);
const TARGET = getAddress("0x000000000000000000000000000000000000dEaD");
const OTHER = getAddress("0x00000000000000000000000000000000000d3ad1");

const SESSION_PK = `0x${"5e".repeat(32)}` as Hex;
const SESSION_ACCOUNT = privateKeyToAccount(SESSION_PK);
const SESSION_KEY_HASH = accountKeyHashForAddress(SESSION_ACCOUNT.address);
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

/** `0x` + the 40 hex digits, ALL UPPER CASE. A valid address; a bad checksum. */
function upperHex(address: Address): Address {
  return `0x${address.slice(2).toUpperCase()}` as Address;
}

/* -------------------------------------------------------------------------- */
/* A scripted account that says YES to absolutely everything                  */
/* -------------------------------------------------------------------------- */

const SELECTORS = {
  getKeys: toFunctionSelector("getKeys()"),
  canExecute: toFunctionSelector("canExecute(bytes32,address,bytes)"),
  spendInfos: toFunctionSelector("spendInfos(bytes32)"),
} as const;

type Node = { readonly transport: (url: string) => Transport; readonly calls: string[] };

function permissiveAccount(spendLimits: readonly Address[] = []): Node {
  const calls: string[] = [];
  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    if (method === "eth_chainId") return numberToHex(BNB_TESTNET.chainId);
    if (method !== "eth_call") throw new Error(`unscripted ${method}`);
    const data = (params as readonly { data?: Hex }[])[0]?.data ?? "0x";
    calls.push(data.slice(0, 10).toLowerCase());
    if (data.startsWith(SELECTORS.getKeys)) {
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
        [[[FUTURE, 2, false, SESSION_ACCOUNT.publicKey]], [SESSION_KEY_HASH]],
      );
    }
    if (data.startsWith(SELECTORS.spendInfos)) {
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
          spendLimits.map((token) => [token, 2, 2n ** 160n, 0n, 0n, 0n, 2n ** 160n]) as [
            Address,
            number,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
          ][],
        ],
      );
    }
    // canExecute: YES to everything, which is what a super-admin key or a wallet
    // whose owner ran one `setCanExecute` self-call actually answers.
    return `0x${"0".repeat(63)}1`;
  };
  return { transport: () => custom({ request }), calls };
}

function sessionRef(allowedCalls: SessionSpec["allowedCalls"]): SessionRef {
  return {
    walletAddress: WALLET,
    chainId: BNB_TESTNET.chainId,
    publicKey: SESSION_ACCOUNT.publicKey,
    spec: {
      allowedCalls,
      spendCaps: [{ limit: 1n, period: "hour" }],
      expiresAt: FUTURE,
    },
    // Deliberately not a real handle: if a guard ever stops firing, the call
    // fails here rather than reaching a relay from a test run.
    handle: {},
  };
}

function providerFor(node: Node): AltanaProvider {
  return new AltanaProvider({ network: BNB_TESTNET, transport: node.transport });
}

/* -------------------------------------------------------------------------- */
/* R1 — the structural refusals cannot be spelled around                      */
/* -------------------------------------------------------------------------- */

describe("audit 2.4 R1: the two targets nothing may reach", () => {
  it("refuses the wallet and the KeyStore in EVERY casing a caller can write", () => {
    // The shared predicate is the whole R1 mechanism. `isAddress` is
    // checksum-STRICT for anything that is not all-lowercase, so an
    // all-uppercase-hex address is the one spelling that could slip past a
    // predicate that treats "not an address" as "not my problem".
    for (const spelling of [WALLET, WALLET.toLowerCase() as Address, upperHex(WALLET)]) {
      assert.notEqual(
        structuralTargetRefusal(spelling, {
          walletAddress: WALLET,
          keyStoreAddress: KEYSTORE,
        }),
        null,
        `the wallet written as ${spelling} must be refused`,
      );
    }
    for (const spelling of [KEYSTORE, KEYSTORE.toLowerCase() as Address, upperHex(KEYSTORE)]) {
      assert.notEqual(
        structuralTargetRefusal(spelling, {
          walletAddress: WALLET,
          keyStoreAddress: KEYSTORE,
        }),
        null,
        `the key registry written as ${spelling} must be refused`,
      );
    }
  });

  it("FAILS CLOSED on a target it cannot parse at all", () => {
    // A predicate whose job is "refuse these two" must never answer "allowed"
    // because it could not read the question.
    assert.notEqual(
      structuralTargetRefusal("0xnot-an-address" as Address, {
        walletAddress: WALLET,
        keyStoreAddress: KEYSTORE,
      }),
      null,
    );
  });

  it("refuses a wallet self-call the PERSISTED SPEC allowlists and the chain permits", async () => {
    // The nastiest reachable shape. `restoreSession` does NOT pass
    // walletAddress/keyStoreAddress to `validateSessionSpec`, so a spec row
    // written before the grant-time check existed — or edited in the store —
    // restores with the wallet on its allowlist. R1's refusal is the only thing
    // standing between that row and a self-call into the account's owner-only
    // surface, and it must run BEFORE the snapshot, not after it.
    const node = permissiveAccount();
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef([{ to: WALLET }, { to: TARGET }]),
        calls: [{ to: WALLET, value: 1n }],
      }),
      (error: unknown) =>
        error instanceof NotAllowedError && /wallet itself/.test(error.message),
    );
    assert.equal(node.calls.length, 0, "a structural refusal asks the chain nothing");
  });

  it("refuses an ALL-UPPERCASE KeyStore call that the account allows", async () => {
    const node = permissiveAccount();
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef([{ to: TARGET }]),
        calls: [{ to: upperHex(KEYSTORE), value: 0n }],
      }),
      (error: unknown) =>
        error instanceof NotAllowedError && /key registry/.test(error.message),
    );
    assert.equal(node.calls.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* R5 — both halves, whatever the calldata's casing                           */
/* -------------------------------------------------------------------------- */

describe("audit 2.4 R5: the value-moving predicate is casing-blind", () => {
  const APPROVE = toFunctionSelector("approve(address,uint256)");
  const upperCalldata = `0x${`${APPROVE.slice(2)}${"00".repeat(64)}`.toUpperCase()}` as Hex;

  it("still demands a spend limit when the selector arrives upper-cased", async () => {
    // `/execute` takes calldata verbatim from the caller. A selector comparison
    // that missed the casing would silently downgrade an `approve` to a
    // non-value-moving call and drop the (u) half of the question.
    const node = permissiveAccount([]);
    await assert.rejects(
      providerFor(node).preflightExecute({
        session: sessionRef([{ to: TARGET }]),
        calls: [{ to: OTHER, data: upperCalldata }],
      }),
      (error: unknown) => error instanceof NotAllowedError,
    );
  });

  it("passes the same call once the account reports a limit for the token", async () => {
    const node = permissiveAccount([OTHER]);
    await providerFor(node).preflightExecute({
      session: sessionRef([{ to: TARGET }]),
      calls: [{ to: OTHER, data: upperCalldata }],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* R3 — positional, not taxonomic                                             */
/* -------------------------------------------------------------------------- */

describe("audit 2.4 R3: the SAME error type classifies by WHERE it was thrown", () => {
  async function tradingHarness(): ReturnType<typeof createHarness> {
    const harness = await createHarness({ config: { trade: tradeConfig() } });
    harness.dataPlane.nextSecurity = safeSecurityPayload();
    await harness.agentStore.updateAgentCaps(OWNER_ADDRESS, AGENT_ID, {
      dailyNativeWei: 10n ** 18n,
    });
    return harness;
  }

  it("/trade: NotAllowedError from the SUBMIT stays UNKNOWN and keeps holding the budget", async () => {
    // This is the direction that is a double spend, and the reason R3 struck the
    // dedicated refusal type: `NotAllowedError` is exactly what a pre-flight
    // refusal throws, so a rule keyed on the TYPE would release the headroom of
    // a batch the relay may already have accepted.
    const harness = await tradingHarness();
    harness.provider.nextError = new NotAllowedError("relay said no, or did it");

    const res = await httpCall(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: (10n ** 16n).toString(10) }),
    });
    const meta = res.body["meta"] as Record<string, unknown>;
    assert.equal(meta["journalState"], "UNKNOWN");
    assert.notEqual(meta["journalState"], "ROLLED_BACK");
    assert.equal(
      await harness.journal.sumNativeSpendSince(AGENT_ID, 0),
      10n ** 16n,
      "an ambiguous submit must keep counting against the day",
    );
  });

  it("/execute: NotAllowedError from the SUBMIT stays UNKNOWN", async () => {
    const harness = await createHarness({ executeRaw: true });
    harness.provider.nextError = new NotAllowedError("relay said no, or did it");

    const res = await httpCall(harness, `/agents/${AGENT_ID}/execute`, {
      method: "POST",
      body: {
        decisionId: "audit-positional-1",
        calls: [{ to: TARGET, value: "1000" }],
      },
    });
    const meta = res.body["meta"] as Record<string, unknown>;
    assert.equal(meta["journalState"], "UNKNOWN");
  });

  it("/trade: the identical error from the PRE-FLIGHT rolls back and releases it", async () => {
    const harness = await tradingHarness();
    harness.provider.preflightError = new NotAllowedError("relay said no, or did it");

    const res = await httpCall(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ amountWei: (10n ** 16n).toString(10) }),
    });
    const meta = res.body["meta"] as Record<string, unknown>;
    assert.equal(meta["journalState"], "ROLLED_BACK");
    assert.equal(await harness.journal.sumNativeSpendSince(AGENT_ID, 0), 0n);
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("RESIDUAL, pinned: the provider's own re-check throws from INSIDE the submit block", async () => {
    // R3 item 10 keeps a pre-flight inside `executeViaSession` as defence in
    // depth, and item 8 makes that pre-flight the chain-reading one — it has to
    // be, or the provider would refuse every post-hire token the route just
    // allowed. The cost is recorded here rather than left to be discovered: a
    // batch that passed the route's pre-flight and then loses the RPC is refused
    // by the SECOND read, from inside the ambiguous block, and is journalled
    // UNKNOWN even though it provably never reached a relay.
    //
    // Not a double spend — it errs in the safe direction — but it is the one
    // case where a provably-unsubmitted batch still holds budget, and a future
    // change must not make it worse.
    let live = true;
    const node = permissiveAccount();
    const flaky = () =>
      custom({
        request: async (args: { method: string; params?: unknown }) => {
          if (!live && args.method === "eth_call") throw new Error("endpoint gone");
          return node.transport("")({ chain: undefined }).request(args as never);
        },
      });
    const provider = new AltanaProvider({ network: BNB_TESTNET, transport: flaky });
    const session = sessionRef([{ to: TARGET }]);

    // Route phase: the snapshot refuses OTHER, the chain allows it, we proceed.
    await provider.preflightExecute({ session, calls: [{ to: OTHER, value: 1n }] });
    live = false;

    await assert.rejects(
      provider.executeViaSession({ session, calls: [{ to: OTHER, value: 1n }] }),
      (error: unknown) => error instanceof NotAllowedError,
      "the second read fails closed, and it fails INSIDE the block the routes journal as UNKNOWN",
    );
  });
});
