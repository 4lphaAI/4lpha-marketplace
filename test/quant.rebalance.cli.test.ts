import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseQuantRebalanceOperatorArgs, runQuantRebalanceOperatorCommand, safeQuantRebalanceCliJson,
  localQuantRebalanceConfigCheck,
  type QuantRebalanceOperatorPorts,
} from "../src/quant/rebalanceOperatorCli.js";

const ACTION = `0x${"11".repeat(32)}`;
const TX = `0x${"22".repeat(32)}`;

describe("Quant rebalancing operator CLI contract", () => {
  it("parses only the five documented commands and proof modes", () => {
    assert.deepEqual(parseQuantRebalanceOperatorArgs(["status"]), { command: "status", jobId: null });
    assert.deepEqual(parseQuantRebalanceOperatorArgs(["status", "--job", "job-1"]), { command: "status", jobId: "job-1" });
    assert.deepEqual(parseQuantRebalanceOperatorArgs(["config-check"]), { command: "config-check" });
    assert.deepEqual(parseQuantRebalanceOperatorArgs(["wallet-census"]), { command: "wallet-census" });
    assert.deepEqual(parseQuantRebalanceOperatorArgs(["resolve", "--action", ACTION, "--calls-id-read"]), {
      command: "resolve", actionId: ACTION, proofMode: "calls-id-read", yesLive: false,
    });
    assert.deepEqual(parseQuantRebalanceOperatorArgs(["resolve", "--action", ACTION, "--tx", TX, "--yes-live"]), {
      command: "resolve", actionId: ACTION, proofMode: "tx", txHash: TX, yesLive: true,
    });
    assert.deepEqual(parseQuantRebalanceOperatorArgs(["resolve", "--action", ACTION, "--not-executed"]), {
      command: "resolve", actionId: ACTION, proofMode: "not-executed", yesLive: false,
    });
    assert.deepEqual(parseQuantRebalanceOperatorArgs(["retire", "--job", "job-1"]), {
      command: "retire", jobId: "job-1", yesLive: false,
    });
  });

  it("rejects unknown, repeated, conflicting, malformed, and unsupported flags", () => {
    for (const argv of [
      ["status", "--yes-live"], ["status", "--job"], ["status", "--job", "a", "--job", "b"],
      ["config-check", "--yes-live"], ["resolve", "--action", ACTION],
      ["resolve", "--action", ACTION, "--tx", TX, "--not-executed"],
      ["resolve", "--action", "bad", "--tx", TX], ["resolve", "--action", ACTION, "--tx", TX, "--tx", TX],
      ["retire", "--job", "job", "--force"], ["self-test"], ["migrate"], ["worker"], ["report"],
    ]) assert.throws(() => parseQuantRebalanceOperatorArgs(argv));
  });

  it("keeps config-check local while OFF and defers readiness even for a synthetic complete profile", () => {
    const empty = localQuantRebalanceConfigCheck({ chainId: 56, enabled: false, flagValid: true,
      configProfileCount: 0, capabilityProfileCount: 0 });
    assert.equal(empty.ready, false);
    assert.deepEqual(empty.reasons, ["rebalancing-disabled", "production-capability-profile-missing", "platform-config-unreviewed"]);
    const futureOff = localQuantRebalanceConfigCheck({ chainId: 56, enabled: false, flagValid: true,
      configProfileCount: 1, capabilityProfileCount: 1 });
    assert.equal(futureOff.ready, false);
    assert.deepEqual(futureOff.reasons, ["activation-check-deferred", "rebalancing-disabled"]);
    const futureOn = localQuantRebalanceConfigCheck({ chainId: 56, enabled: true, flagValid: true,
      configProfileCount: 1, capabilityProfileCount: 1 });
    assert.equal(futureOn.ready, false);
    assert.deepEqual(futureOn.reasons, ["activation-check-deferred"]);
  });

  it("keeps rehearsal commands read-only and applies only after a proven fresh CAS", async () => {
    let writes = 0; let proofReads = 0;
    const rehearsal = {
      ok: true, code: "proof-ready", evidence: { proofDigest: `0x${"aa".repeat(32)}` },
      async apply() { writes += 1; return { status: "applied" }; },
    };
    const ports: QuantRebalanceOperatorPorts = {
      async status(jobId) { return { jobId, ciphertext: undefined, writes: false }; },
      async configCheck() { return { profileReady: false, writes: false }; },
      async walletCensus() { return { migrationInstalled: false, writes: false }; },
      async resolve() { proofReads += 1; return rehearsal; },
      async retire() { proofReads += 1; return rehearsal; },
    };
    const status = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["status"]), ports);
    assert.equal(writes, 0);
    assert.equal(status.error, undefined);
    const rehearsalResult = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["resolve", "--action", ACTION, "--tx", TX]), ports);
    assert.equal(proofReads, 1);
    assert.equal(writes, 0);
    assert.equal(rehearsalResult.data.kind, "resolve");
    assert.equal(rehearsalResult.data.writes, false);
    const applied = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["retire", "--job", "job-1", "--yes-live"]), ports);
    assert.equal(proofReads, 2);
    assert.equal(writes, 1);
    assert.equal(applied.data.kind, "retire");
    assert.equal(applied.data.writes, true);
  });

  it("refuses affirmative apply when the current proof is unavailable", async () => {
    let writes = 0;
    const ports: QuantRebalanceOperatorPorts = {
      async status() { return {}; }, async configCheck() { return {}; }, async walletCensus() { return {}; },
      async resolve() { return { ok: false, code: "proof-stale", evidence: {}, async apply() { writes += 1; } }; },
      async retire() { return { ok: false, code: "key-active", evidence: {}, async apply() { writes += 1; } }; },
    };
    const result = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["resolve", "--action", ACTION, "--calls-id-read", "--yes-live"]), ports);
    assert.equal(result.error, "proof-stale");
    assert.equal(writes, 0);
  });

  it("refuses a fresh apply CAS when evidence changes after the read-only rehearsal", async () => {
    let revision = 1; let writes = 0;
    const ports: QuantRebalanceOperatorPorts = {
      async status() { return {}; }, async configCheck() { return {}; }, async walletCensus() { return {}; },
      async resolve() {
        const capturedRevision = revision;
        revision += 1;
        return { ok: true, code: "proof-ready", evidence: { actionId: ACTION, proofDigest: `0x${"aa".repeat(32)}` },
          async apply() {
            if (revision !== capturedRevision) throw Object.assign(new Error("proof-stale"), { code: "proof-stale" });
            writes += 1; return { actionId: ACTION, proofDigest: `0x${"aa".repeat(32)}` };
          } };
      },
      async retire() { return { ok: false, code: "unused", evidence: {}, async apply() { return {}; } }; },
    };
    await assert.rejects(runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs([
      "resolve", "--action", ACTION, "--tx", TX, "--yes-live",
    ]), ports), (error: unknown) => typeof error === "object" && error !== null
      && "code" in error && (error as { code: unknown }).code === "proof-stale");
    assert.equal(writes, 0);
  });

  it("emits only fixed public projections, even when readers contain secrets or envelopes", async () => {
    const ports: QuantRebalanceOperatorPorts = {
      async status() { return { schema: "ready", code: null, jobs: [{
        jobId: "job-1", strategyKind: "rebalance", strategyId: "strategy-1", wallet: `0x${"33".repeat(20)}`,
        status: "admitted", rowVersion: 4, admitted: true, allocationWei: "10000000000000000000",
        endsAtMs: 100, sessionExpiresAtMs: 100, revokedAtMs: null, holdCode: null,
        claimMode: "active", claimGeneration: "8", accountingState: "verified", accountingRev: "3",
        checkStates: ["rebalancing"], actionStates: ["settled"], actionSetDigest: `0x${"44".repeat(32)}`,
        reportStatus: "unavailable", managedBalances: { USDC: "123456", WBNB: "77", ETH: "0", CAKE: "0" },
        bootstrapStatus: "bootstrap-partial", reportAttempts: 2, reportPayloadDigest: `0x${"55".repeat(32)}`,
        reportResponseStatus: 0, reportNotesApplied: null,
        envelopeJson: "ENVELOPE_CIPHERTEXT_SECRET", descriptorJson: "SERIALIZED_SESSION_SECRET",
        signerPrivateKey: "PRIVATE_KEY_SECRET",
      }] }; },
      async configCheck() { return {}; }, async walletCensus() { return {}; },
      async resolve() { return { ok: true, code: "proof-ready", evidence: {
        actionId: ACTION, txHash: TX, proofDigest: `0x${"aa".repeat(32)}`, signerPrivateKey: "PRIVATE_KEY_SECRET",
        envelopeJson: "ENVELOPE_CIPHERTEXT_SECRET", note: "SERIALIZED_SESSION_SECRET",
      }, async apply() { return { actionId: ACTION, proofDigest: `0x${"aa".repeat(32)}`, privateKey: "PRIVATE_KEY_SECRET" }; } }; },
      async retire() { return { ok: false, code: "proof-refused", evidence: {}, async apply() { return {}; } }; },
    };
    const result = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["status"]), ports);
    const json = safeQuantRebalanceCliJson(result);
    assert.match(json, /job-1/u);
    assert.match(json, /"USDC": "123456"/u);
    assert.match(json, /bootstrap-partial/u);
    assert.match(json, /"reportAttempts": 2/u);
    assert.doesNotMatch(json, /ENVELOPE_CIPHERTEXT_SECRET|SERIALIZED_SESSION_SECRET|PRIVATE_KEY_SECRET|signerPrivateKey|envelopeJson|descriptorJson/u);
    const resolve = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["resolve", "--action", ACTION, "--tx", TX]), ports);
    const proofJson = safeQuantRebalanceCliJson(resolve);
    assert.match(proofJson, /proof-ready/u);
    assert.doesNotMatch(proofJson, /ENVELOPE_CIPHERTEXT_SECRET|SERIALIZED_SESSION_SECRET|PRIVATE_KEY_SECRET|signerPrivateKey|envelopeJson/u);
  });
});
