/**
 * FIX-REVIEW tests for the hand-fixes applied after `PHASE2.4-AUDIT.md`.
 *
 * Written by the independent fix-reviewer, not by the author of the fixes.
 * `CLAUDE.md` requires a post-audit hand-fix to be reviewed on its own, because
 * Phase 0's unreviewed hotfixes carried four high-severity bugs. Two of the five
 * fixes changed behaviour that NO test pinned, and an unpinned behaviour change
 * is one refactor away from being silently undone:
 *
 *   A4 — the two STRUCTURAL refusals (a call back into the wallet, a call into
 *        the KeyStore) now run OUTSIDE the `bypassLocalPolicyCheck` branch, so
 *        R1 item 1's word "unconditionally" is true of what ships. The only
 *        tests that exercised the bypass asserted the opposite property — that a
 *        bypass "asks nobody anything" — and both still pass, because a
 *        structural refusal asks nobody anything either. Nothing pinned the
 *        refusal itself.
 *   A6 — an ERRATUM to Revision 2 item 29. The spec says
 *        `status != 1 -> VENUE_GRADUATED`; the code now answers that for status
 *        4 ALONE and `VENUE_UNSUPPORTED` for 0/2/3/5. Deviating from a NORMATIVE
 *        item on purpose is exactly the kind of decision that has to be visible
 *        to the next reader, and the only flap status any test covered was 4.
 *
 * Offline: the RPC transport is scripted and the SDK client is never built.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { custom, getAddress, numberToHex, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BNB_TESTNET } from "@altananetwork/sdk";
import { AltanaProvider } from "../src/wallet/altana.js";
import { NotAllowedError, type SessionRef } from "../src/core/types.js";
import {
  AGENT_ID,
  call,
  createHarness,
  safeSecurityPayload,
  tradeBody,
  tradeConfig,
  type Harness,
} from "./support/serverHarness.js";

/* -------------------------------------------------------------------------- */
/* A4 — the structural refusals hold under a bypass                           */
/* -------------------------------------------------------------------------- */

const WALLET = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
const KEYSTORE = getAddress(BNB_TESTNET.keyStore);
const TARGET = getAddress("0x000000000000000000000000000000000000dEaD");
const SESSION_ACCOUNT = privateKeyToAccount(`0x${"5e".repeat(32)}` as Hex);
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

/** A node that answers the chain id and treats any read as a test failure. */
function noReadNode(): { readonly transport: () => Transport; readonly reads: string[] } {
  const reads: string[] = [];
  const request = async ({ method }: { method: string }): Promise<unknown> => {
    if (method === "eth_chainId") return numberToHex(BNB_TESTNET.chainId);
    reads.push(method);
    throw new Error(`a structural refusal must not read the chain (${method})`);
  };
  return { transport: () => custom({ request }), reads };
}

function sessionRef(): SessionRef {
  return {
    walletAddress: WALLET,
    chainId: BNB_TESTNET.chainId,
    publicKey: SESSION_ACCOUNT.publicKey,
    spec: {
      // The allowlist ALLOWS both forbidden targets. Under a bypass the
      // allowlist is not consulted at all, so this is here to make the point
      // that no allowlist state can be what saves us.
      allowedCalls: [{ to: WALLET }, { to: KEYSTORE }, { to: TARGET }],
      spendCaps: [{ limit: 1n, period: "hour" }],
      expiresAt: FUTURE,
    },
    // Not a real handle: if a guard stops firing, the call dies here rather
    // than reaching a relay from a test run.
    handle: {},
  };
}

describe("fix-review A4: bypassLocalPolicyCheck cannot reach the wallet or the KeyStore", () => {
  it("refuses a wallet self-call under a bypass, without asking the chain", async () => {
    const node = noReadNode();
    const provider = new AltanaProvider({ network: BNB_TESTNET, transport: node.transport });
    await assert.rejects(
      provider.executeViaSession({
        session: sessionRef(),
        calls: [{ to: WALLET, value: 1n }],
        bypassLocalPolicyCheck: true,
      }),
      (error: unknown) =>
        error instanceof NotAllowedError && /wallet itself/.test(error.message),
    );
    assert.deepEqual(node.reads, []);
  });

  it("refuses a KeyStore call under a bypass, in a casing `isAddress` calls invalid", async () => {
    const node = noReadNode();
    const provider = new AltanaProvider({ network: BNB_TESTNET, transport: node.transport });
    await assert.rejects(
      provider.executeViaSession({
        session: sessionRef(),
        calls: [
          { to: TARGET, value: 0n },
          { to: `0x${KEYSTORE.slice(2).toUpperCase()}` as Address, value: 0n },
        ],
        bypassLocalPolicyCheck: true,
      }),
      (error: unknown) =>
        error instanceof NotAllowedError && /key registry/.test(error.message),
    );
    assert.deepEqual(node.reads, []);
  });

  it("STILL bypasses the allowlist for every other target — the fix did not widen", async () => {
    // D1 rule 5: `bypassLocalPolicyCheck` keeps its exact meaning. A target that
    // is NOT one of the two structural ones must still sail past the snapshot
    // under a bypass, which it proves by dying at the handle instead.
    const node = noReadNode();
    const provider = new AltanaProvider({ network: BNB_TESTNET, transport: node.transport });
    await assert.rejects(
      provider.executeViaSession({
        session: { ...sessionRef(), spec: { ...sessionRef().spec, allowedCalls: [] } },
        calls: [{ to: TARGET, value: 1n }],
        bypassLocalPolicyCheck: true,
      }),
      /Session handle was not created by this provider/,
    );
    assert.deepEqual(node.reads, []);
  });
});

/* -------------------------------------------------------------------------- */
/* A6 — only status 4 is a graduation                                          */
/* -------------------------------------------------------------------------- */

const PORTAL = getAddress("0xaaaa0000000000000000000000000000000000aa");

async function flapHarness(): Promise<Harness> {
  const harness = await createHarness({
    config: {
      trade: tradeConfig({
        venues: { ...tradeConfig().venues, flapPortal: PORTAL },
      }),
    },
  });
  harness.dataPlane.nextSecurity = safeSecurityPayload();
  return harness;
}

function metaOf(body: Record<string, unknown>): Record<string, unknown> {
  const value = body["meta"];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

describe("fix-review A6: the flap status codes a caller can act on", () => {
  // Invalid(0), InDuel(2), Killed(3), Staged(5). Revision 2 item 29 read
  // literally sends the holder of each of these to re-route on Pancake, where
  // for a Killed or never-existent token there is no pool at all.
  for (const status of [0, 2, 3, 5]) {
    it(`answers VENUE_UNSUPPORTED, not VENUE_GRADUATED, for status ${status}`, async () => {
      const harness = await flapHarness();
      harness.provider.flapStateOverrides = { status };
      const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
        method: "POST",
        body: tradeBody({ venue: "flap", decisionId: `d-flap-${status}` }),
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(metaOf(res.body)["deniedBy"], "venue");
      assert.equal(metaOf(res.body)["code"], "VENUE_UNSUPPORTED");
      assert.equal(harness.provider.executeCalls.length, 0);
    });
  }

  it("keeps VENUE_GRADUATED for status 4, which is the one that really migrated", async () => {
    const harness = await flapHarness();
    harness.provider.flapStateOverrides = { status: 4 };
    const res = await call(harness, `/agents/${AGENT_ID}/trade`, {
      method: "POST",
      body: tradeBody({ venue: "flap", decisionId: "d-flap-4" }),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(metaOf(res.body)["code"], "VENUE_GRADUATED");
    assert.equal(harness.provider.executeCalls.length, 0);
  });
});
