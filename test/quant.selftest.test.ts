/**
 * Gate-1 self-test tooling (QUANT-GRID R2.10 / R3.7 / BC36).
 *
 * The self-test must exercise the PRODUCTION parsers and admission, so these
 * tests prove: the granted spec projects and admits under the real predicate,
 * the serializer round-trips through the real plaintext parser and reproduces
 * the checked-in `serializeSession` fixture byte-for-byte, the file transport
 * returns the record types the HTTPS parsers produce, and config refuses any
 * process that mixes self-test and production credentials.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileQuantTransport,
  QUANT_SELF_TEST_STRATEGY_ID,
  quantSelfTestSessionSpec,
  serializeGrantedSession,
  writeSelfTestFile,
  type QuantSelfTestFile,
} from "../src/quant/selftest.js";
import {
  parseSessionPlaintext,
  projectGrantedPermissions,
  assertQuantSessionAdmissible,
} from "../src/quant/admission.js";
import { buildLadder } from "../src/quant/grid.js";
import {
  QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56,
  resolveQuantEnabled, resolveQuantRuntimeConfig, resolveQuantStrategyParams, quantParamsDigest,
  type QuantEnv,
} from "../src/quant/config.js";
import { deriveKeypair, open, seal } from "../src/quant/envelope.js";

const RELAY = "https://relay.altana.network";
const WALLET = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
const E18 = 10n ** 18n;

function baseEnv(overrides: QuantEnv = {}): QuantEnv {
  const params = resolveQuantStrategyParams({});
  return {
    QUANT_ENABLED: "true",
    EXECUTION_NETWORK: "mainnet",
    DATABASE_URL: "postgres://localhost/x",
    QUANT_ENVELOPE_KEY: `0x${"11".repeat(32)}`,
    QUANT_AGENT_ID: "agent-1",
    QUANT_PARAMS_DIGEST: quantParamsDigest(params),
    ...overrides,
  };
}

describe("self-test session spec (R2.10) — the wizard's shape", () => {
  const now = 1_800_000_000;
  const spec = quantSelfTestSessionSpec({
    router: QUANT_ROUTER_56, u: QUANT_U_56, wbnb: QUANT_WBNB_56,
    uDayCapWei: 10n * E18, wbnbDayCapWei: E18, nativeDayCapWei: 10n ** 16n,
    expiresAt: now + 2 * 86_400, nowSeconds: now, walletAddress: WALLET,
  });

  it("carries exactly the three rules and three caps admission requires", () => {
    assert.equal(spec.allowedCalls.length, 3);
    assert.equal(spec.spendCaps.length, 3);
    assert.equal(spec.spendCaps.filter((cap) => cap.token === undefined).length, 1);
  });

  it("projects and is ADMITTED by the production predicate on a 10 U job", () => {
    const params = resolveQuantStrategyParams({});
    const mid = 740n * E18;
    const ladder = buildLadder({ allocationUWei: 10n * E18, p0E18: mid, params });
    assert.ok(ladder.ok);
    if (!ladder.ok) return;
    const agentKey = `0x${"22".repeat(32)}` as Hex;
    const publicKey = privateKeyToAccount(agentKey).publicKey;
    const permissions = {
      calls: spec.allowedCalls.map((rule) => ({ to: rule.to as Address, signature: rule.selector as string })),
      spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }), limit: cap.limit, period: cap.period })),
    };
    const plaintext = serializeGrantedSession({
      walletAddress: WALLET, publicKey, expiry: now + 2 * 86_400, permissions, privateKey: agentKey,
    });
    const parsed = parseSessionPlaintext(plaintext);
    assert.ok(parsed.ok, String((parsed as { ok: boolean; code?: string }).code ?? "ok"));
    if (!parsed.ok) return;
    const projection = projectGrantedPermissions(parsed.session.permissions, {
      expiry: parsed.session.expiry, nowSeconds: now, termDays: 2, walletAddress: WALLET,
    });
    assert.ok(projection.ok, String((projection as { ok: boolean; code?: string }).code ?? "ok"));
    if (!projection.ok) return;
    const verdict = assertQuantSessionAdmissible({
      session: parsed.session,
      spec: projection.spec,
      job: {
        tradingWalletAddress: WALLET,
        sessionExpiresAtMs: (now + 2 * 86_400) * 1_000,
      },
      router: QUANT_ROUTER_56, u: QUANT_U_56, wbnb: QUANT_WBNB_56,
      params,
      ladder: { ...ladder.ladder, midE18: mid },
      nowSeconds: now,
    });
    assert.ok(verdict.ok, String((verdict as { ok: boolean; code?: string }).code ?? "ok"));
  });
});

describe("serializeGrantedSession — the SDK's serializeSession shape", () => {
  it("reproduces the checked-in @bnbagent/sdk fixture byte-for-byte", () => {
    const fixture = readFileSync("test/fixtures/quant/bnbagent-serialized-session.json", "utf8").trim();
    const produced = serializeGrantedSession({
      walletAddress: "0x000000000000000000000000000000000000dEaD",
      publicKey: `0x04${"ab".repeat(64)}` as Hex,
      expiry: 1_800_000_000,
      permissions: {
        calls: [{
          to: getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E"),
          signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
        }],
        spend: [{
          token: getAddress("0xcE24439F2D9C6a2289F741120FE202248B666666"),
          limit: 10n * E18, period: "day",
        }],
      },
      privateKey: `0x${"22".repeat(32)}` as Hex,
    });
    assert.equal(produced, fixture);
  });

  it("seals to our key and opens back to the same plaintext", () => {
    const keypair = deriveKeypair(`0x${"11".repeat(32)}`);
    const plaintext = "{\"version\":1}";
    const envelope = seal(plaintext, keypair.publicKey);
    assert.equal(open(envelope, keypair), plaintext);
  });
});

describe("FileQuantTransport — the same record types as the HTTPS parsers", () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-selftest-"));
  const path = join(dir, "selftest.json");
  const file: QuantSelfTestFile = {
    version: 1,
    config: {
      chainId: 56, u: QUANT_U_56, uDecimals: 18,
      tradableTokens: [{ address: QUANT_WBNB_56, decimals: 18, priceRoute: "direct" }],
      venueAllowlist: [QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56],
    },
    agentKey: { encryptionPublicKey: "AA==", algorithm: "x25519-hkdf-chacha20poly1305" },
    inbox: [{ envelopeId: "e1", quantJobId: "j1", ephemeralPublicKey: "a", nonce: "b", ciphertext: "c", algorithm: "x25519-hkdf-chacha20poly1305" }],
    jobs: [{
      id: "j1", status: "ACTIVE", strategyId: QUANT_SELF_TEST_STRATEGY_ID,
      tradingWalletAddress: WALLET, allocationUWei: (10n * E18).toString(10),
      dailyCapUWei: (10n * E18).toString(10), termDays: 2,
      startedAtMs: 1, endsAtMs: 2, sessionExpiresAtMs: 3, revokedAtMs: null,
    }],
    reports: [],
  };
  writeSelfTestFile(path, file);
  const transport = new FileQuantTransport(path, { u: QUANT_U_56, wbnb: QUANT_WBNB_56, router: QUANT_ROUTER_56 });

  it("answers the pinned venue block and an empty inbox before the file exists", async () => {
    const fresh = new FileQuantTransport(join(dir, "missing.json"), { u: QUANT_U_56, wbnb: QUANT_WBNB_56, router: QUANT_ROUTER_56 });
    const block = await fresh.config();
    assert.ok(block.ok && block.data.chainId === 56);
    const inbox = await fresh.inbox();
    assert.ok(inbox.ok && inbox.data.items.length === 0);
  });

  it("answers job() with bigint fields and the self-test strategy id", async () => {
    const job = await transport.job("j1");
    assert.ok(job.ok);
    if (!job.ok) return;
    assert.equal(job.data.allocationUWei, 10n * E18);
    assert.equal(job.data.strategyId, "self-test");
    assert.equal((await transport.job("nope")).ok, false);
  });

  it("re-reads the file on every call, so an edit is seen next cycle", async () => {
    writeSelfTestFile(path, { ...file, jobs: [{ ...file.jobs[0]!, revokedAtMs: 99 }] });
    const job = await transport.job("j1");
    assert.ok(job.ok && job.data.revokedAtMs === 99);
  });

  it("records reports and registered keys in the file", async () => {
    await transport.report("j1", { trades: [] });
    await transport.registerKey({ agentId: "a", encryptionPublicKey: "BB==", algorithm: "x" });
    const reread = JSON.parse(readFileSync(path, "utf8")) as QuantSelfTestFile;
    assert.equal(reread.reports.length, 1);
    assert.equal(reread.agentKey.encryptionPublicKey, "BB==");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("config — self-test mode is exclusive with production credentials", () => {
  it("refuses a self-test file together with an API key", () => {
    assert.throws(() => resolveQuantRuntimeConfig(baseEnv({
      QUANT_SELF_TEST_FILE: "x.json", QUANT_API_KEY: "k", QUANT_STRATEGY_ID: "self-test",
    }), { publicRpcUrl: RELAY }), /mutually exclusive/u);
  });
  it("requires strategy id self-test in self-test mode, and refuses it outside", () => {
    assert.throws(() => resolveQuantRuntimeConfig(baseEnv({
      QUANT_SELF_TEST_FILE: "x.json", QUANT_STRATEGY_ID: "strategy-1",
    }), { publicRpcUrl: RELAY }), /must be "self-test"/u);
    assert.throws(() => resolveQuantRuntimeConfig(baseEnv({
      QUANT_API_KEY: "k", QUANT_STRATEGY_ID: "self-test",
    }), { publicRpcUrl: RELAY }), /refused without/u);
  });
  it("accepts the self-test mode without an API key, and production without a file", () => {
    const st = resolveQuantRuntimeConfig(baseEnv({
      QUANT_SELF_TEST_FILE: "x.json", QUANT_STRATEGY_ID: "self-test",
    }), { publicRpcUrl: RELAY });
    assert.equal(st.selfTestFile, "x.json");
    assert.equal(st.apiKey, "");
    const prod = resolveQuantRuntimeConfig(baseEnv({
      QUANT_API_KEY: "k", QUANT_STRATEGY_ID: "strategy-1",
    }), { publicRpcUrl: RELAY });
    assert.equal(prod.selfTestFile, null);
    assert.equal(resolveQuantEnabled(baseEnv()), true);
  });
});

describe("QUANT-SELFTEST R2/R4/R5 — isolation, atomic claim, production parsers", () => {
  it("a worker lists only jobs of ITS strategy, and a wire refresh never re-labels a job", async () => {
    const { MemoryQuantJobStore } = await import("../src/store/quantJobs.js");
    const store = new MemoryQuantJobStore();
    await store.discoverJob({ quantJobId: "j-self", envelopeJson: "{}", envelopeId: "e1", strategyId: "self-test", nowMs: 1 });
    await store.discoverJob({ quantJobId: "j-prod", envelopeJson: "{}", envelopeId: "e2", strategyId: "strategy-1", nowMs: 1 });
    const wire = (id: string, strategyId: string) => ({
      quantJobId: id, strategyId, tradingWallet: WALLET, allocationUWei: 10n * E18,
      dailyCapUWei: 10n * E18, termDays: 2, startedAtMs: 1, endsAtMs: 2, sessionExpiresAtMs: 3,
      revokedAtMs: null, nowMs: 2,
    });
    await store.updateJobWire(wire("j-self", "self-test"));
    await store.updateJobWire(wire("j-prod", "strategy-1"));
    assert.deepEqual((await store.listWorkableJobs("self-test")).map((j) => j.quantJobId), ["j-self"]);
    assert.deepEqual((await store.listWorkableJobs("strategy-1")).map((j) => j.quantJobId), ["j-prod"]);
    // R7: a wire record naming ANOTHER strategy is refused outright (null), and nothing of it is applied.
    assert.equal(await store.updateJobWire({ ...wire("j-self", "strategy-1"), allocationUWei: 99n * E18 }), null);
    assert.equal((await store.getJob("j-self"))?.strategyId, "self-test");
    assert.equal((await store.getJob("j-self"))?.allocationUWei, 10n * E18);
    // R2: a freshly discovered row is already owned by its source and invisible to the other side.
    await store.discoverJob({ quantJobId: "j-fresh", envelopeJson: "{}", envelopeId: "e3", strategyId: "self-test", nowMs: 1 });
    assert.equal((await store.listWorkableJobs("strategy-1")).some((j) => j.quantJobId === "j-fresh"), false);
  });

  it("the file claim is exclusive: a second claim fails before any grant", async () => {
    const { claimSelfTestFile, releaseSelfTestClaim } = await import("../src/quant/selftest.js");
    const dir = mkdtempSync(join(tmpdir(), "quant-claim-"));
    const path = join(dir, "claim.json");
    const placeholder: QuantSelfTestFile = {
      version: 1,
      config: { chainId: 56, u: QUANT_U_56, uDecimals: 18, tradableTokens: [{ address: QUANT_WBNB_56, decimals: 18, priceRoute: "direct" }], venueAllowlist: [QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56] },
      agentKey: { encryptionPublicKey: null, algorithm: null }, inbox: [], jobs: [], reports: [],
    };
    claimSelfTestFile(path, placeholder);
    assert.throws(() => claimSelfTestFile(path, placeholder), /EEXIST/u);
    releaseSelfTestClaim(path);
    claimSelfTestFile(path, placeholder);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the file transport refuses a malformed job through the PRODUCTION parser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quant-parse-"));
    const path = join(dir, "bad.json");
    writeSelfTestFile(path, {
      version: 1,
      config: { chainId: 56, u: QUANT_U_56, uDecimals: 18, tradableTokens: [{ address: QUANT_WBNB_56, decimals: 18, priceRoute: "direct" }], venueAllowlist: [QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56] },
      agentKey: { encryptionPublicKey: null, algorithm: null },
      inbox: [{ envelopeId: "", quantJobId: "j", ephemeralPublicKey: "a", nonce: "b", ciphertext: "c", algorithm: "x" }],
      jobs: [{ id: "j", status: "ACTIVE", strategyId: "self-test", tradingWalletAddress: "0xnot-an-address" as Address, allocationUWei: "1", dailyCapUWei: "1", termDays: 2, startedAtMs: 1, endsAtMs: 2, sessionExpiresAtMs: 3, revokedAtMs: null }],
      reports: [],
    });
    const transport = new FileQuantTransport(path, { u: QUANT_U_56, wbnb: QUANT_WBNB_56, router: QUANT_ROUTER_56 });
    assert.equal((await transport.job("j")).ok, false);
    // A malformed inbox item is SKIPPED, the HTTPS transport's semantics (R5).
    const inbox = await transport.inbox();
    assert.ok(inbox.ok && inbox.data.items.length === 0);
    rmSync(dir, { recursive: true, force: true });
  });
});
