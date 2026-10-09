/**
 * Env-only hosting (Railway): the boot check names missing VARIABLES, never prints a value, never writes, and
 * the real entrypoint exits with that message when a production boot is missing something.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertRuntimeEnv, checkRuntimeEnv, PLAIN_VARS, SECRET_VARS } from "../src/runtimeEnv.js";

const ADDR = "0x592EF127feFd45eAA56fE0D715dAAF72F998A652";
const cfg = { wallet: { address: ADDR }, llm: { pieverse: { key_hash: "0xabc" } }, storage: { kind: "ipfs" } };
const SENT = { ks: "SENTINEL_KEYSTORE_9f3a", pw: "SENTINEL_PASSWORD_77b1", key: "SENTINEL_LLMKEY_c0de", store: "SENTINEL_STOREKEY_5e5e" };
const keystore = (address = ADDR) => JSON.stringify({ address: address.replace(/^0x/, "").toLowerCase(), crypto: { ciphertext: SENT.ks } });
const full = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    WALLET_KEYSTORE_JSON: keystore(),
    WALLET_PASSWORD: SENT.pw,
    PIEVERSE_LLM_API_KEY: SENT.key,
    STORAGE_API_URL: "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    STORAGE_API_KEY: SENT.store,
    BNBAGENT_PUBLIC_URL: "https://desk.4lpha.tech",
    PORT: "8080",
    SELLER_CALLER_IDENTITY: "railway-client-ip",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
};

function capture<T>(fn: () => T): { result: T | undefined; error: unknown; logs: string } {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    return { result: fn(), error: undefined, logs: lines.join("\n") };
  } catch (e) {
    return { result: undefined, error: e, logs: lines.join("\n") };
  } finally {
    Object.assign(console, saved);
  }
}

describe("checkRuntimeEnv", () => {
  it("is not enforced outside production (local bag dev, tests)", () => {
    const r = checkRuntimeEnv({}, cfg);
    assert.deepEqual([r.enforced, r.missing, r.problems], [false, [], []]);
  });
  it("a complete production env passes with no warning", () => {
    const r = checkRuntimeEnv(full(), cfg);
    assert.deepEqual([r.enforced, r.missing, r.problems, r.warnings], [true, [], [], []]);
  });
  it("names every missing variable, in order", () => {
    const r = checkRuntimeEnv({ NODE_ENV: "production" }, cfg);
    assert.deepEqual(r.missing, ["WALLET_KEYSTORE_JSON", "WALLET_PASSWORD", "PIEVERSE_LLM_API_KEY", "STORAGE_API_URL", "BNBAGENT_PUBLIC_URL"]);
  });
  it("blank values count as missing", () => {
    for (const name of ["WALLET_KEYSTORE_JSON", "WALLET_PASSWORD", "PIEVERSE_LLM_API_KEY", "STORAGE_API_URL"]) {
      assert.deepEqual(checkRuntimeEnv(full({ [name]: "   " }), cfg).missing, [name], name);
    }
  });
  it("a missing or blank STORAGE_API_KEY refuses the boot for a hosted ipfs pinning service", () => {
    for (const key of [undefined, "", "   "]) {
      const r = checkRuntimeEnv(full({ STORAGE_API_KEY: key }), cfg);
      assert.deepEqual(r.missing, []);
      assert.equal(r.problems.length, 1, String(key));
      assert.ok(r.problems[0]?.includes("STORAGE_API_KEY"));
    }
  });
  it("a missing STORAGE_API_KEY is only a warning for a local pinning stub or another storage kind", () => {
    for (const url of ["http://localhost:5001/api/v0/add", "http://127.0.0.1:5001/x", "http://[::1]:5001/x"]) {
      const r = checkRuntimeEnv(full({ STORAGE_API_KEY: undefined, STORAGE_API_URL: url }), cfg);
      assert.deepEqual([r.missing, r.problems], [[], []], url);
      assert.equal(r.warnings.length, 1, url);
    }
    const other = checkRuntimeEnv(full({ STORAGE_API_KEY: undefined }), { ...cfg, storage: { kind: "local" } });
    assert.deepEqual([other.missing, other.problems], [[], []]);
    assert.equal(other.warnings.length, 1);
    // a host that merely starts with localhost is not local
    assert.equal(checkRuntimeEnv(full({ STORAGE_API_KEY: undefined, STORAGE_API_URL: "https://localhost.evil.example/x" }), cfg).problems.length, 1);
  });
  it("the public URL must be https; the AgentCore variable is accepted too", () => {
    assert.ok(checkRuntimeEnv(full({ BNBAGENT_PUBLIC_URL: "http://desk.4lpha.tech" }), cfg).problems.some((p) => p.includes("https")));
    assert.deepEqual(checkRuntimeEnv(full({ BNBAGENT_PUBLIC_URL: undefined, AGENTCORE_RUNTIME_URL: "https://x.example" }), cfg).missing, []);
    assert.deepEqual(checkRuntimeEnv(full({ BNBAGENT_PUBLIC_URL: "not a url" }), cfg).missing, ["BNBAGENT_PUBLIC_URL"]);
  });
  it("the keystore must be valid JSON for the wallet the config anchors (any address case)", () => {
    assert.ok(checkRuntimeEnv(full({ WALLET_KEYSTORE_JSON: "{not json" }), cfg).problems.some((p) => p.includes("not valid JSON")));
    assert.ok(checkRuntimeEnv(full({ WALLET_KEYSTORE_JSON: "{}" }), cfg).problems.some((p) => p.includes("no address")));
    assert.ok(checkRuntimeEnv(full({ WALLET_KEYSTORE_JSON: keystore("0x1111111111111111111111111111111111111111") }), cfg).problems.some((p) => p.includes("different wallet")));
    assert.deepEqual(checkRuntimeEnv(full({ WALLET_KEYSTORE_JSON: keystore(ADDR.toUpperCase().replace("0X", "0x")) }), cfg).problems, []);
  });
  it("studio.toml must anchor the wallet and carry the Pieverse key hash", () => {
    assert.ok(checkRuntimeEnv(full(), { llm: cfg.llm }).problems.some((p) => p.includes("[wallet].address")));
    assert.ok(checkRuntimeEnv(full(), { wallet: cfg.wallet }).problems.some((p) => p.includes("key_hash")));
  });
  it("PORT must be a real port when set", () => {
    for (const p of ["abc", "0", "70000", "80.5", "8080.0", "65536", "080000", "1e3", "0x50", "-1", " 80", "80 ", "+80", "123456"]) assert.ok(checkRuntimeEnv(full({ PORT: p }), cfg).problems.some((m) => m.includes("PORT")), p);
    assert.deepEqual(checkRuntimeEnv(full({ PORT: undefined }), cfg).problems, []);
    for (const p of ["1", "80", "8080", "65535"]) assert.deepEqual(checkRuntimeEnv(full({ PORT: p }), cfg).problems, [], p);
  });
  it("a production boot needs a caller identity source, and only one", () => {
    const none = checkRuntimeEnv(full({ SELLER_CALLER_IDENTITY: undefined }), cfg);
    assert.equal(none.problems.length, 1);
    assert.ok(none.problems[0]?.includes("SELLER_CALLER_IDENTITY") && none.problems[0]?.includes("SELLER_TRUSTED_CALLER_HEADER"));
    assert.deepEqual(checkRuntimeEnv(full({ SELLER_CALLER_IDENTITY: undefined, SELLER_TRUSTED_CALLER_HEADER: "x-edge-caller" }), cfg).problems, []);
    assert.deepEqual(checkRuntimeEnv(full({ SELLER_CALLER_IDENTITY: "  Railway-Client-IP " }), cfg).problems, []);
    const both = checkRuntimeEnv(full({ SELLER_TRUSTED_CALLER_HEADER: "x-edge-caller" }), cfg);
    assert.equal(both.problems.length, 1);
    assert.ok(both.problems[0]?.includes("only one"));
    assert.ok(checkRuntimeEnv(full({ SELLER_CALLER_IDENTITY: undefined, SELLER_TRUSTED_CALLER_HEADER: "bad header!" }), cfg).problems.some((m) => m.includes("not a valid header name")));
    assert.deepEqual(checkRuntimeEnv({ SELLER_TRUSTED_CALLER_HEADER: "bad header!" }, cfg).problems, [], "outside production the trusted-header mode is unchanged");
  });
  it("on AWS AgentCore (BNBAGENT_RUNTIME_SECRET_ID set) no caller identity source is needed, but conflicts are still refused", () => {
    const agentcore = full({ SELLER_CALLER_IDENTITY: undefined, BNBAGENT_RUNTIME_SECRET_ID: "rt-1", BNBAGENT_PUBLIC_URL: undefined, AGENTCORE_RUNTIME_URL: "https://runtime.example.aws" });
    assert.deepEqual(checkRuntimeEnv(agentcore, cfg).problems, []);
    assert.deepEqual(checkRuntimeEnv(agentcore, cfg).missing, []);
    // a blank id does not count as AgentCore
    assert.equal(checkRuntimeEnv({ ...agentcore, BNBAGENT_RUNTIME_SECRET_ID: "   " }, cfg).problems.length, 1);
    assert.equal(checkRuntimeEnv(full({ SELLER_CALLER_IDENTITY: undefined }), cfg).problems.length, 1, "not AgentCore: still refused");
    // unknown value and both-set stay refused on AgentCore too
    assert.equal(checkRuntimeEnv({ ...agentcore, SELLER_CALLER_IDENTITY: "SENTINEL_MODE" }, cfg).problems.length, 1);
    assert.equal(checkRuntimeEnv({ ...agentcore, SELLER_CALLER_IDENTITY: "railway-client-ip", SELLER_TRUSTED_CALLER_HEADER: "x-edge-caller" }, cfg).problems.length, 1);
    const { error } = capture(() => assertRuntimeEnv({ ...agentcore, SELLER_CALLER_IDENTITY: "SENTINEL_MODE" }, cfg));
    assert.ok(error instanceof Error && !(error as Error).message.includes("SENTINEL"));
    // the rest of the check is unchanged on AgentCore
    assert.deepEqual(checkRuntimeEnv({ ...agentcore, WALLET_PASSWORD: undefined }, cfg).missing, ["WALLET_PASSWORD"]);
  });
  it("an unknown SELLER_CALLER_IDENTITY refuses the boot, in production or not, without printing the value", () => {
    for (const env of [full({ SELLER_CALLER_IDENTITY: "SENTINEL_MODE_1a2b" }), { SELLER_CALLER_IDENTITY: "SENTINEL_MODE_1a2b" }]) {
      const { error } = capture(() => assertRuntimeEnv(env, cfg));
      assert.ok(error instanceof Error);
      assert.ok((error as Error).message.includes("SELLER_CALLER_IDENTITY"));
      assert.ok(!(error as Error).message.includes("SENTINEL_MODE_1a2b"));
    }
    assert.deepEqual(checkRuntimeEnv({ SELLER_TRUSTED_CALLER_HEADER: "x-edge-caller", SELLER_CALLER_IDENTITY: "railway-client-ip" }, cfg).problems.length, 1);
    assert.deepEqual(checkRuntimeEnv({ SELLER_CALLER_IDENTITY: "railway-client-ip" }, cfg).problems, []);
  });
  it("the project's real studio.toml satisfies the toml side of the check", () => {
    const toml = readFileSync(fileURLToPath(new URL("../studio.toml", import.meta.url)), "utf8");
    assert.ok(toml.includes(`address = "${ADDR}"`));
  });
});

describe("assertRuntimeEnv: a clear failure that never carries a value", () => {
  it("throws one message with the missing names and no secret", () => {
    const env = full({ WALLET_KEYSTORE_JSON: undefined, STORAGE_API_URL: undefined });
    const { error, logs } = capture(() => assertRuntimeEnv(env, cfg));
    assert.ok(error instanceof Error);
    const msg = (error as Error).message;
    assert.match(msg, /^Cannot start in production: missing environment variables: WALLET_KEYSTORE_JSON, STORAGE_API_URL\./);
    assert.ok(msg.includes("Railway runbook"));
    for (const s of Object.values(SENT)) assert.ok(!msg.includes(s) && !logs.includes(s), s);
  });
  it("problems about values name the variable only: bad JSON, wrong wallet", () => {
    for (const ks of ["{SENTINEL_BAD_JSON", keystore("0x1111111111111111111111111111111111111111")]) {
      const { error, logs } = capture(() => assertRuntimeEnv(full({ WALLET_KEYSTORE_JSON: ks }), cfg));
      assert.ok(error instanceof Error);
      const text = (error as Error).message + logs;
      for (const s of [...Object.values(SENT), "SENTINEL_BAD_JSON", "1111111111111111111111111111111111111111", "ciphertext"]) assert.ok(!text.includes(s), s);
    }
  });
  it("a good env neither throws nor logs a value, and warnings go through the injected sink", () => {
    const warned: string[] = [];
    const { error, logs } = capture(() =>
      assertRuntimeEnv(full({ STORAGE_API_KEY: undefined, STORAGE_API_URL: "http://localhost:5001/x" }), cfg, (m) => warned.push(m)),
    );
    assert.equal(error, undefined);
    assert.equal(logs, "");
    assert.equal(warned.length, 1);
    assert.ok(warned[0]?.includes("STORAGE_API_KEY"));
    const loud = capture(() => assertRuntimeEnv(full(), cfg));
    assert.equal(loud.logs, "");
  });
  it("does nothing outside production", () => {
    assert.equal(capture(() => assertRuntimeEnv({}, {})).error, undefined);
  });
  it("the module cannot write or print: no fs, no console, no process.stdout in its source", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/runtimeEnv.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/node:fs|writeFile|appendFile|mkdir|process\.std|console\.(log|error|info|debug)/.test(src));
  });
  it("lists the variable names for the runbook: secrets and plain are disjoint and complete", () => {
    assert.deepEqual([...SECRET_VARS].sort(), ["PIEVERSE_LLM_API_KEY", "STORAGE_API_KEY", "WALLET_KEYSTORE_JSON", "WALLET_PASSWORD"]);
    assert.deepEqual([...PLAIN_VARS].sort(), ["BNBAGENT_PUBLIC_URL", "STORAGE_API_URL"]);
  });
});

describe("the real entrypoint in production mode", () => {
  const agentDir = fileURLToPath(new URL("../", import.meta.url));
  const boot = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/unifiedMain.ts"], {
      cwd: agentDir,
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
  it("exits 1 with the missing variable names and leaks nothing it was given", () => {
    const r = boot({ NODE_ENV: "production", WALLET_PASSWORD: SENT.pw, PIEVERSE_LLM_API_KEY: SENT.key, STORAGE_API_KEY: SENT.store });
    assert.equal(r.status, 1);
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    assert.ok(out.includes("Cannot start in production: missing environment variables: WALLET_KEYSTORE_JSON, STORAGE_API_URL, BNBAGENT_PUBLIC_URL"), out);
    for (const s of Object.values(SENT)) assert.ok(!out.includes(s), s);
  });
});
