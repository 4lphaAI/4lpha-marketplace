/**
 * Offline tests for the resumable spike state.
 *
 * The state file is not a log — it is what tells the next run "step 6 already
 * revoked that session, skip it". Two ways that becomes dangerous:
 *
 *   - the file belongs to a DIFFERENT owner, so its verdicts describe a key
 *     this run has never touched. Skipping a revoke that never happened for
 *     this key leaves a live session behind;
 *   - the file belongs to a different NETWORK, so mainnet inherits testnet's
 *     "already swept".
 *
 * Both are treated as fatal here rather than as warnings.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Address } from "viem";
import {
  openSpikeState,
  readState,
  stateFilePath,
  writeState,
} from "../scripts/spike/state.js";

const OWNER = "0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4" as Address;
const OTHER_OWNER = "0x000000000000000000000000000000000000dEaD" as Address;

let directory: string;
let directoryUrl: URL;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "4lpha-state-"));
  // A trailing separator is required for URL resolution to treat it as a dir.
  directoryUrl = pathToFileURL(join(directory, "/"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function write(name: string, contents: string): void {
  writeFileSync(join(directory, name), contents, "utf8");
}

describe("stateFilePath", () => {
  it("gives mainnet its own file so a testnet run cannot mask it", () => {
    const testnet = basename(fileURLToPath(stateFilePath("testnet", directoryUrl)));
    const mainnet = basename(fileURLToPath(stateFilePath("mainnet", directoryUrl)));

    assert.equal(testnet, ".spike-state.json");
    assert.equal(mainnet, ".spike-state.mainnet.json");
    assert.notEqual(testnet, mainnet);
  });
});

describe("readState", () => {
  it("returns an empty state when the file is absent", () => {
    assert.deepEqual(readState(stateFilePath("testnet", directoryUrl)), { steps: {} });
  });

  it("survives a corrupt file rather than wedging the spike", () => {
    write(".spike-state.json", "{ this is not json");

    assert.deepEqual(readState(stateFilePath("testnet", directoryUrl)), { steps: {} });
  });

  it("survives a file whose top level is not an object", () => {
    write(".spike-state.json", "[1,2,3]");

    assert.deepEqual(readState(stateFilePath("testnet", directoryUrl)), { steps: {} });
  });

  it("survives a file whose steps field is the wrong shape", () => {
    write(".spike-state.json", JSON.stringify({ ownerAddress: OWNER, steps: "nope" }));

    const state = readState(stateFilePath("testnet", directoryUrl));
    assert.deepEqual(state.steps, {});
    assert.equal(state.ownerAddress, OWNER);
  });
});

describe("openSpikeState", () => {
  it("stamps the owner onto a fresh state file", () => {
    const store = openSpikeState({
      network: "testnet",
      ownerAddress: OWNER,
      directory: directoryUrl,
    });

    assert.equal(store.state.ownerAddress, OWNER);
    assert.match(readFileSync(join(directory, ".spike-state.json"), "utf8"), /561b/);
  });

  it("fails loudly when the persisted owner is a different key", () => {
    write(
      ".spike-state.json",
      JSON.stringify({
        ownerAddress: OTHER_OWNER,
        steps: { "6-owner-only-revoke": { status: "PASS", note: "", evidence: [], at: "" } },
      }),
    );

    assert.throws(
      () =>
        openSpikeState({
          network: "testnet",
          ownerAddress: OWNER,
          directory: directoryUrl,
        }),
      /belongs to owner/i,
    );
  });

  it("resumes for the same owner regardless of checksum casing", () => {
    write(
      ".spike-state.json",
      JSON.stringify({
        ownerAddress: OWNER.toLowerCase(),
        steps: { "3-grant-session": { status: "PASS", note: "", evidence: [], at: "" } },
      }),
    );

    const store = openSpikeState({
      network: "testnet",
      ownerAddress: OWNER,
      directory: directoryUrl,
    });

    assert.equal(store.isDone("3-grant-session"), true);
  });

  it("does not let a testnet file answer for a mainnet run", () => {
    write(
      ".spike-state.json",
      JSON.stringify({
        ownerAddress: OWNER,
        steps: { "8-owner-only-withdraw": { status: "PASS", note: "", evidence: [], at: "" } },
      }),
    );

    const mainnet = openSpikeState({
      network: "mainnet",
      ownerAddress: OWNER,
      directory: directoryUrl,
    });

    assert.equal(mainnet.isDone("8-owner-only-withdraw"), false);
  });

  it("treats only PASS as done", () => {
    const store = openSpikeState({
      network: "testnet",
      ownerAddress: OWNER,
      directory: directoryUrl,
    });

    store.record("5b value above spend cap", "FAIL", "rejected for the wrong reason");
    assert.equal(store.isDone("5b value above spend cap"), false);

    store.record("4-in-scope-execute", "PASS", "confirmed");
    assert.equal(store.isDone("4-in-scope-execute"), true);
  });

  it("persists each recorded step immediately", () => {
    const store = openSpikeState({
      network: "mainnet",
      ownerAddress: OWNER,
      directory: directoryUrl,
    });

    store.record("6-owner-only-revoke", "PASS", "killed", ["tx 0xabc"]);

    // Read through a second store: a crash between steps must not lose the
    // verdict, which is the entire point of the file.
    const reopened = openSpikeState({
      network: "mainnet",
      ownerAddress: OWNER,
      directory: directoryUrl,
    });
    assert.equal(reopened.isDone("6-owner-only-revoke"), true);
    assert.deepEqual(reopened.state.steps["6-owner-only-revoke"]?.evidence, ["tx 0xabc"]);
  });

  it("round-trips session facts through writeState/readState", () => {
    const path = stateFilePath("testnet", directoryUrl);
    writeState(
      {
        ownerAddress: OWNER,
        session: {
          publicKey: "0xabc",
          address: OTHER_OWNER,
          expiresAt: 1_800_003_600,
          allowedTarget: OTHER_OWNER,
          capWei: "5000000000000000",
          capPeriod: "hour",
        },
        steps: {},
      },
      path,
    );

    assert.equal(readState(path).session?.expiresAt, 1_800_003_600);
  });
});
