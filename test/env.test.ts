/**
 * Offline tests for the spike's `.env` layering.
 *
 * This file is where funded mainnet keys live. Every test here is about one of
 * two ways to lose money: silently overwriting a key that already holds funds,
 * or writing a key that a higher-precedence layer shadows — which returns
 * cleanly, leaves a file that looks correct, and makes the run act on a
 * different key than the one it just persisted.
 *
 * Nothing here touches the repo's real `.env` / `.env.local`: every case runs
 * against a fresh temp directory injected through `EnvFiles`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readEnvFile,
  readEnvValue,
  writeEnvValue,
  type EnvFiles,
} from "../scripts/spike/env.js";

const KEY = "OWNER_TEST_KEY";
const VALUE_A = `0x${"11".repeat(32)}`;
const VALUE_B = `0x${"22".repeat(32)}`;

let directory: string;
let files: EnvFiles;

function writeEnv(name: string, contents: string): void {
  writeFileSync(join(directory, name), contents, "utf8");
}

function readRaw(name: string): string {
  return readFileSync(join(directory, name), "utf8");
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "4lpha-env-"));
  files = {
    envPath: pathToFileURL(join(directory, ".env")),
    envLocalPath: pathToFileURL(join(directory, ".env.local")),
  };
  delete process.env[KEY];
  delete process.env["SPIKE_ROTATE_KEY"];
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env[KEY];
  delete process.env["SPIKE_ROTATE_KEY"];
});

describe("readEnvValue layering", () => {
  it("prefers .env.local over .env", () => {
    writeEnv(".env", `${KEY}=${VALUE_A}\n`);
    writeEnv(".env.local", `${KEY}=${VALUE_B}\n`);

    assert.equal(readEnvValue(KEY, files), VALUE_B);
  });

  it("prefers a real process env var over both files", () => {
    writeEnv(".env", `${KEY}=${VALUE_A}\n`);
    writeEnv(".env.local", `${KEY}=${VALUE_B}\n`);
    process.env[KEY] = "0xprocess";

    assert.equal(readEnvValue(KEY, files), "0xprocess");
  });

  it("ignores commented-out assignments", () => {
    writeEnv(".env", `# ${KEY}=${VALUE_A}\n`);

    assert.equal(readEnvValue(KEY, files), undefined);
  });

  it("strips surrounding quotes", () => {
    writeEnv(".env", `${KEY}="${VALUE_A}"\n`);

    assert.equal(readEnvFile(files).get(KEY), VALUE_A);
  });

  it("returns undefined when neither file exists", () => {
    assert.equal(readEnvValue(KEY, files), undefined);
  });
});

describe("writeEnvValue", () => {
  it("creates .env and writes a new key", () => {
    writeEnvValue(KEY, VALUE_A, files);

    assert.equal(readEnvValue(KEY, files), VALUE_A);
    assert.match(readRaw(".env"), new RegExp(`^${KEY}=${VALUE_A}$`, "m"));
  });

  it("refuses to overwrite an existing value", () => {
    writeEnv(".env", `${KEY}=${VALUE_A}\n`);

    assert.throws(
      () => writeEnvValue(KEY, VALUE_B, files),
      /refusing to overwrite/i,
    );
    // The old value must survive the refusal, or the refusal was pointless.
    assert.equal(readEnvValue(KEY, files), VALUE_A);
  });

  it("allows an overwrite when SPIKE_ROTATE_KEY names that key", () => {
    writeEnv(".env", `${KEY}=${VALUE_A}\n`);
    process.env["SPIKE_ROTATE_KEY"] = KEY;

    writeEnvValue(KEY, VALUE_B, files);

    assert.equal(readEnvValue(KEY, files), VALUE_B);
  });

  it("does not accept a rotation opt-in for a DIFFERENT key", () => {
    writeEnv(".env", `${KEY}=${VALUE_A}\n`);
    process.env["SPIKE_ROTATE_KEY"] = "SOME_OTHER_KEY";

    assert.throws(() => writeEnvValue(KEY, VALUE_B, files), /refusing to overwrite/i);
  });

  it("is idempotent when the value is unchanged", () => {
    writeEnv(".env", `${KEY}=${VALUE_A}\n`);

    assert.doesNotThrow(() => writeEnvValue(KEY, VALUE_A, files));
  });

  it("throws when .env.local shadows the value it just wrote", () => {
    // The write "succeeds" at the filesystem level and changes nothing about
    // what the spike will read. Silence here is how a rotation gets signed
    // with the old key.
    writeEnv(".env.local", `${KEY}=${VALUE_B}\n`);
    process.env["SPIKE_ROTATE_KEY"] = KEY;

    assert.throws(() => writeEnvValue(KEY, VALUE_A, files), /shadowing/i);
  });

  it("throws when a process env var shadows the value it just wrote", () => {
    process.env[KEY] = VALUE_B;
    process.env["SPIKE_ROTATE_KEY"] = KEY;

    assert.throws(() => writeEnvValue(KEY, VALUE_A, files), /shadowing/i);
  });

  it("never writes to .env.local", () => {
    const original = `# operator secrets\nUSER1_PRIVATE_KEY=${VALUE_B}\n`;
    writeEnv(".env.local", original);

    writeEnvValue("AGENT_SESSION_TEST_KEY", VALUE_A, files);

    assert.equal(readRaw(".env.local"), original);
  });

  it("preserves other entries and the header comment", () => {
    writeEnv(".env", `# header\nOTHER=keep-me\n`);

    writeEnvValue(KEY, VALUE_A, files);

    const contents = readRaw(".env");
    assert.match(contents, /^# header$/m);
    assert.match(contents, /^OTHER=keep-me$/m);
    assert.match(contents, new RegExp(`^${KEY}=${VALUE_A}$`, "m"));
  });

  it("does not resurrect a commented-out assignment, and appends exactly one", () => {
    writeEnv(".env", `# ${KEY}=${VALUE_B}\n`);

    writeEnvValue(KEY, VALUE_A, files);

    const lines = readRaw(".env").split("\n");
    assert.equal(lines.filter((line) => line === `${KEY}=${VALUE_A}`).length, 1);
    // The comment stays a comment.
    assert.equal(lines.includes(`# ${KEY}=${VALUE_B}`), true);
    assert.equal(readEnvValue(KEY, files), VALUE_A);
  });

  it("replaces an existing assignment in place rather than appending", () => {
    writeEnv(".env", `${KEY}=${VALUE_A}\nOTHER=keep-me\n`);
    process.env["SPIKE_ROTATE_KEY"] = KEY;

    writeEnvValue(KEY, VALUE_B, files);

    const assignments = readRaw(".env")
      .split("\n")
      .filter((line) => line.startsWith(`${KEY}=`));
    assert.deepEqual(assignments, [`${KEY}=${VALUE_B}`]);
  });

  it("writes the file owner-only", (t) => {
    if (process.platform === "win32") {
      // Windows has no POSIX mode bits; fs.chmod maps onto the read-only
      // attribute alone, so the assertion would be meaningless rather than
      // wrong. The call is still exercised above on every platform.
      t.skip("POSIX file modes are not modelled on Windows");
      return;
    }
    writeEnvValue(KEY, VALUE_A, files);

    assert.equal(statSync(join(directory, ".env")).mode & 0o777, 0o600);
  });
});
