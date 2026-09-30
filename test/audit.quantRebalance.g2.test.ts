/** Final-audit regressions for the G2 file rehearsal wallet claim (Claude Opus 5.5). No I/O beyond a temp dir. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getAddress, keccak256, stringToBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSessionPlaintext, permissionsDigest } from "../src/quant/admission.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import { QUANT_ENVELOPE_ALGORITHM } from "../src/quant/envelope.js";
import { rebalanceCanonicalEncode } from "../src/quant/rebalanceCanonical.js";
import { claimSelfTestFile, serializeGrantedSession } from "../src/quant/selftest.js";
import {
  closeG2GrantClaim, createG2GrantClaim, G2_JOBS, g2ClaimPath, g2ProposedFileDigest, g2SessionSpec,
  loadG2FileProfiles, publishG2GrantedOutput, publishG2ReadyClaim, readG2GrantClaim, readG2ReadyFile,
  type G2File, type G2GrantClaim,
} from "../src/quant/rebalanceSelftest.js";

const WALLET = getAddress("0x3333333333333333333333333333333333333333");

function inDir(run: () => void): void {
  const before = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "quant-g2-audit-"));
  try {
    process.chdir(directory);
    mkdirSync("scripts/tmp", { recursive: true });
    run();
  } finally {
    process.chdir(before);
    rmSync(directory, { recursive: true, force: true });
  }
}

function claimFor(allocation: 10 | 75, keyByte = "34"): G2GrantClaim {
  const map = G2_JOBS[allocation];
  const publicKey = `0x04${keyByte.repeat(64)}` as Hex;
  return { version: 1, chainId: 56, wallet: WALLET, database: map.db, role: map.db, server: "127.0.0.1:5432",
    jobId: map.job, file: resolve(map.file), fileFactsDigest: g2ProposedFileDigest(allocation, map.file),
    publicKey, keyId: keccak256(publicKey), permissionsDigest: `0x${"78".repeat(32)}` as Hex,
    expirySec: 2_000_000_000, state: "claiming", outputDigest: null, grantNativeDebitWei: null,
    baselineBlock: "1", baselineHash: `0x${"ab".repeat(32)}` as Hex,
    actualBaseline: { USDC: (100n * 10n ** 18n).toString(10), WBNB: "0", ETH: "0", CAKE: "0", USDT: "0", U: "59", BNB: "100" },
    protectedBaseline: { USDC: (BigInt(100 - allocation) * 10n ** 18n).toString(10),
      WBNB: "0", ETH: "0", CAKE: "0", USDT: "0", U: "59", BNB: "0" },
    approvedNativeFloatWei: "100" };
}

const dead = (claim: G2GrantClaim) => ({ blockNumber: "2", blockHash: `0x${"cd".repeat(32)}` as Hex,
  timestampSec: claim.expirySec, keyId: claim.keyId, expired: true as const });
const digest = (value: unknown): Hex => keccak256(stringToBytes(rebalanceCanonicalEncode(value)));

test("audit G2: a high-75 claim is refused until a released low-10 archive exists (R2.4/D3 ordering)", () => inDir(() => {
  assert.throws(() => createG2GrantClaim(claimFor(75)), /g2-wallet-already-claimed/u);
  assert.equal(existsSync(g2ClaimPath(WALLET)), false);
  assert.equal(existsSync(`${g2ClaimPath(WALLET)}.guard`), false, "a clean refusal releases its own guard");
}));

test("audit G2: a stale closer refuses a changed canonical claim without archiving or removing it (R3 identity)", () => inDir(() => {
  createG2GrantClaim(claimFor(10));
  const old = publishG2ReadyClaim(claimFor(10), `0x${"90".repeat(32)}` as Hex, 1n);
  // The canonical path now holds a different, valid ready claim (a different key).
  const successor: G2GrantClaim = { ...old, publicKey: `0x04${"56".repeat(64)}` as Hex,
    keyId: keccak256(`0x04${"56".repeat(64)}` as Hex) };
  writeFileSync(g2ClaimPath(WALLET), `${JSON.stringify(successor)}\n`);
  assert.throws(() => closeG2GrantClaim(old, dead(old)), /g2-claim-changed/u);
  assert.equal(readG2GrantClaim(WALLET).keyId, successor.keyId);
  const archive = `${g2ClaimPath(WALLET)}.${old.jobId}.${digest(old).slice(2, 18)}.archive`;
  assert.equal(existsSync(archive), false);
}));

test("audit G2: close never overwrites an existing archive destination (R3 no-overwrite)", () => inDir(() => {
  createG2GrantClaim(claimFor(10));
  const ready = publishG2ReadyClaim(claimFor(10), `0x${"90".repeat(32)}` as Hex, 1n);
  const archive = `${g2ClaimPath(WALLET)}.${ready.jobId}.${digest(ready).slice(2, 18)}.archive`;
  writeFileSync(archive, "prior-evidence\n");
  assert.throws(() => closeG2GrantClaim(ready, dead(ready)));
  assert.equal(readFileSync(archive, "utf8"), "prior-evidence\n");
  assert.equal(readG2GrantClaim(WALLET).state, "ready", "the canonical claim stays blocking");
}));

test("audit G2: the worker's ready-file gate refuses while a wallet mutation guard exists (R3 guard)", () => inDir(() => {
  const capture = loadG2FileProfiles().block;
  const privateKey = generatePrivateKey();
  const publicKey = privateKeyToAccount(privateKey).publicKey;
  const keypair = quantKeypairFromSeed(`0x${randomBytes(32).toString("hex")}`);
  const base = claimFor(10);
  const spec = g2SessionSpec({ allocation: 10, riskCaps: { WBNB: 20n * 10n ** 18n }, verifiedPreGrantPaymentMaxWei: null,
    expiresAt: base.expirySec, nowSeconds: base.expirySec - 2 * 86_400, wallet: WALLET });
  const permissions = { calls: spec.allowedCalls.map((rule) => ({ ...(rule.to === undefined ? {} : { to: rule.to }),
    ...(rule.selector === undefined ? {} : { signature: rule.selector }) })),
    spend: spec.spendCaps.map((cap) => ({ ...(cap.token === undefined ? {} : { token: cap.token }), limit: cap.limit, period: cap.period })) };
  const parsed = parseSessionPlaintext(serializeGrantedSession({ walletAddress: WALLET, publicKey, expiry: base.expirySec, permissions, privateKey }));
  assert.equal(parsed.ok, true); if (!parsed.ok) return;
  const claim = { ...base, publicKey, keyId: keccak256(publicKey), permissionsDigest: permissionsDigest(parsed.session.permissions) };
  createG2GrantClaim(claim);
  claimSelfTestFile(claim.file, { version: 1, config: capture,
    agentKey: { encryptionPublicKey: keypair.publicKey.toString("base64"), algorithm: QUANT_ENVELOPE_ALGORITHM },
    inbox: [], jobs: [], reports: [], grantState: "claiming" } as G2File);
  publishG2GrantedOutput({ claim, publicKey, permissions, privateKey, keypair, config: capture,
    job: { id: claim.jobId, status: "ACTIVE", strategyId: "self-test-rebalance-g2", tradingWalletAddress: WALLET,
      allocationUWei: (10n * 10n ** 18n).toString(10), dailyCapUWei: (20n * 10n ** 18n).toString(10), termDays: 2,
      startedAtMs: 1_000, endsAtMs: 1_000 + 2 * 86_400_000, sessionExpiresAtMs: claim.expirySec * 1000, revokedAtMs: null },
    grantNativeDebitWei: 1n });
  assert.equal(readG2ReadyFile(claim.file, 10, keypair).grantState, "ready");
  writeFileSync(`${g2ClaimPath(WALLET)}.guard`, "left-behind\n");
  assert.throws(() => readG2ReadyFile(claim.file, 10, keypair), /g2-claim-file-mismatch/u);
}));
