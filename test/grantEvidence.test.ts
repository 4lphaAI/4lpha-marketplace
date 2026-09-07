import { encodeFunctionResult } from "viem";
import { ACCOUNT_ABI } from "../src/wallet/abis.js";
import { custom } from "viem";
import { bsc } from "viem/chains";
import { createGrantEvidenceReader } from "../src/wallet/grantEvidence.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToBytes, toFunctionSelector, zeroAddress, type Hex } from "viem";
import {
  assessGrantEvidence,
  equalCanonicalPermissions,
  fundingRequirement,
  grantDigest,
  normalizeGrantPermissions,
  type GrantEvidenceSnapshot, expectedGrantCalls, isKeyDoesNotExistRevert, KEY_DOES_NOT_EXIST_SELECTOR } from "../src/wallet/grantEvidence.js";
import { checkHireSizing, hireSizingPreview } from "../src/ops/policy.js";
import type { PendingGrant } from "../src/store/agents.js";
import { canonicalEncode } from "../src/auth/canonical.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const SESSION = getAddress("0x3333333333333333333333333333333333333333");
const TOKEN = getAddress("0x4444444444444444444444444444444444444444");
const HASH = `0x${"55".repeat(32)}` as Hex;
const KEY_ID = `0x${"66".repeat(32)}` as Hex;
const PUBKEY = `0x04${"77".repeat(64)}` as Hex;
const permissions = {
  calls: [{ to: TOKEN, signature: "transfer(address,uint256)" }, { to: WALLET }],
  spend: [{ period: "day" as const, limit: 123n }, { token: TOKEN, period: "hour" as const, limit: 456n }],
};

function pending(): PendingGrant {
  const expiresAt = 2_000;
  return {
    version: 1, recoveredOwner: OWNER, walletAddress: WALLET, sessionAddress: SESSION,
    sessionPublicKey: PUBKEY, accountKeyHash: HASH, keyStoreKeyId: KEY_ID,
    sessionSpec: { allowedCalls: [], spendCaps: [], expiresAt }, permissions,
    grantDigest: grantDigest({ permissions, expiresAt, walletAddress: WALLET, sessionAddress: SESSION }), expiresAt,
    sizing: { openNativeBudgetWei: "100", capDayWei: "1000", sizingPreset: "grid-v1", sizingPresetVersion: 1 },
    funding: fundingRequirement({ registrationFeeWei: 10n, activeKeyIds: [], relayGasHeadroomWei: 30n, balanceWei: 100n, observedAtSec: 1 }),
    createdAtSec: 1, keyStoreVerdictAtS1: "not-registered", provisionActionId: `0x${"88".repeat(32)}` as Hex,
  };
}

function exactEvidence(): GrantEvidenceSnapshot {
  return {
    relayKeys: [{ hash: HASH, expiry: 2_000, role: "session", permissions: {
      calls: [{ to: TOKEN, signature: toFunctionSelector("transfer(address,uint256)") }, { to: WALLET, signature: "0x32323232" }, { to: "0xaf140d0416a994aebb3fa6212b16ce6700f09751", signature: "0x32323232" }],
      spend: [{ token: null, period: "day", limit: 123n }, { token: TOKEN, period: "hour", limit: 456n }],
    } }],
    accountKey: { expiry: 2_000, isSuperAdmin: false },
    accountSpend: [{ token: zeroAddress, period: 2, limit: 123n }, { token: TOKEN, period: 1, limit: 456n }],
    canExecute: [true, true, true], keyStore: { kind: "registered", publicKey: PUBKEY }, ownerVerdict: "verified",
  };
}

describe("grant evidence normalizer", () => {
  it("normalizes selector-bound, target-only, and selector-only call rows", () => {
    const persisted = normalizeGrantPermissions({ kind: "persisted", value: permissions });
    const relay = normalizeGrantPermissions({ kind: "relay", value: exactEvidence().relayKeys[0]!.permissions });
    // The relay set carries the SDK's implicit orchestrator rule; the signed set alone must NOT equal it.
    assert.equal(equalCanonicalPermissions(persisted, relay), false);
    assert.equal(equalCanonicalPermissions({ ...persisted, calls: expectedGrantCalls(permissions) }, relay), true);
    assert.deepEqual(normalizeGrantPermissions({ kind: "relay", value: { calls: [
      { to: TOKEN, signature: "0x12345678" },
      { to: TOKEN, signature: "0x32323232" },
      { signature: "0x87654321" },
      { to: "0x3232323232323232323232323232323232323232", signature: "0x87654322" },
    ] } }).calls, [
      { to: "*", selector: "0x87654321" },
      { to: "*", selector: "0x87654322" },
      { to: TOKEN.toLowerCase(), selector: "*" },
      { to: TOKEN.toLowerCase(), selector: "0x12345678" },
    ]);
  });

  it("normalizes native spellings, ERC-20 addresses, and all six periods", () => {
    const native = normalizeGrantPermissions({ kind: "relay", value: { spend: [
      { period: "minute", limit: 1n },
      { token: null, period: "hour", limit: "2" },
      { token: zeroAddress, period: "day", limit: 3 },
      { token: TOKEN.toUpperCase().replace("0X", "0x"), period: "week", limit: 4n },
    ] } });
    assert.deepEqual(native.spend.map((row) => row.token), [TOKEN.toLowerCase(), "native", "native", "native"]);
    const periods = normalizeGrantPermissions({ kind: "account-spend", value: [0, 1, 2, 3, 4, 5].map((period) => ({ period, token: null, limit: BigInt(period + 1) })) });
    assert.deepEqual(periods.spend.map((row) => row.period).sort(), ["day", "hour", "minute", "month", "week", "year"]);
  });

  it("rejects duplicate and malformed rows", () => {
    assert.throws(() => normalizeGrantPermissions({ kind: "relay", value: { calls: [{ to: TOKEN, signature: "0x12345678" }, { to: TOKEN, signature: "0x12345678" }] } }));
    assert.throws(() => normalizeGrantPermissions({ kind: "relay", value: { calls: [{ to: TOKEN, signature: "0x12" }] } }));
    assert.throws(() => normalizeGrantPermissions({ kind: "relay", value: { calls: [{ to: TOKEN, selector: "0x12345678" }] } }));
    assert.throws(() => normalizeGrantPermissions({ kind: "relay", value: { calls: [{ to: TOKEN, signature: "0x12345678", extra: true }] } }));
    assert.throws(() => normalizeGrantPermissions({ kind: "relay", value: { spend: "not-an-array" } }));
    assert.throws(() => normalizeGrantPermissions({ kind: "account-spend", value: [{ token: null, period: 9, limit: 1n }] }));
  });

  it("treats extra and missing valid rows as unequal", () => {
    const expected = normalizeGrantPermissions({ kind: "persisted", value: permissions });
    const relay = exactEvidence().relayKeys[0]!.permissions as { calls: readonly unknown[]; spend: readonly unknown[] };
    assert.equal(equalCanonicalPermissions(expected, normalizeGrantPermissions({ kind: "relay", value: {
      calls: [...relay.calls, { to: TOKEN, signature: "0xdeadbeef" }], spend: relay.spend,
    } })), false);
    assert.equal(equalCanonicalPermissions(expected, normalizeGrantPermissions({ kind: "relay", value: {
      calls: relay.calls.slice(1), spend: relay.spend,
    } })), false);
  });

  it("arms only exact evidence and returns the closed missing reasons", () => {
    assert.deepEqual(assessGrantEvidence(pending(), exactEvidence(), 1_000), []);
    const cases: readonly [string, (value: GrantEvidenceSnapshot) => GrantEvidenceSnapshot][] = [
      ["account-key", (value) => ({ ...value, accountKey: null })],
      ["permissions-differ", (value) => ({ ...value, relayKeys: [{ ...value.relayKeys[0]!, expiry: 1_999 }] })],
      // FINDINGS (bi): Porto appends {orchestrator, any} to every session key; a relay
      // set WITHOUT it is not the grant the SDK produces, so it must not arm either.
      ["permissions-differ", (value) => ({ ...value, relayKeys: [{ ...value.relayKeys[0]!, permissions: {
        ...(value.relayKeys[0]!.permissions as object),
        calls: ((value.relayKeys[0]!.permissions as { calls: readonly { to?: string }[] }).calls).filter((row) => row.to !== "0xaf140d0416a994aebb3fa6212b16ce6700f09751"),
      } }] })],
      ["keystore-id", (value) => ({ ...value, keyStore: { kind: "missing" } })],
      ["keystore-pubkey", (value) => ({ ...value, keyStore: { kind: "registered", publicKey: `0x04${"99".repeat(64)}` as Hex } })],
      ["wallet-not-registered", (value) => ({ ...value, ownerVerdict: "not-registered" })],
      ["wallet-owner-mismatch", (value) => ({ ...value, ownerVerdict: "no-matching-key" })],
      ["evidence-unreadable", (value) => ({ ...value, ownerVerdict: "unreadable" })],
    ];
    for (const [reason, mutate] of cases) assert.deepEqual(assessGrantEvidence(pending(), mutate(exactEvidence()), 1_000), [reason]);
    assert.deepEqual(assessGrantEvidence(pending(), exactEvidence(), 2_000), ["expired"]);
  });
});

describe("hire sizing and funding", () => {
  it("binds the grant digest to the shared canonical encoder", () => {
    const expiresAt = 2_000;
    assert.equal(grantDigest({ permissions, expiresAt, walletAddress: WALLET, sessionAddress: SESSION }), keccak256(stringToBytes(canonicalEncode({
      permissions, expiresAt, walletAddress: WALLET, sessionAddress: SESSION,
    }))));
  });

  it("uses grid-v1@1 fixed-grid maxima and strict one-wei cap", () => {
    const preview = hireSizingPreview({ openNativeBudgetWei: 1_000n, feeBps: 100, relayFeePerSubmitWei: 10n, sizingPreset: "grid-v1" });
    assert.deepEqual(preview.terms, { maxExitSequencesPerDay: 4, openPositionsCount: 2, maxGridFlipsPerDay: 12, maxRequotesPerDay: 0, maxLadderMovesPerDay: 0, maxShiftMotionsPerDay: 0 });
    assert.deepEqual(preview.reserves, { exitWei: "120", protectWei: "40", gridFlipWei: "360", shiftWei: "0", totalWei: "520" });
    assert.equal(preview.minimumCapDayWei, "1531");
    assert.equal(checkHireSizing({ capDayWei: 1_531n, openNativeBudgetWei: 1_000n, feeBps: 100, relayFeePerSubmitWei: 10n, sizingPreset: "grid-v1" }).ok, true);
    assert.equal(checkHireSizing({ capDayWei: 1_530n, openNativeBudgetWei: 1_000n, feeBps: 100, relayFeePerSubmitWei: 10n, sizingPreset: "grid-v1" }).ok, false);
  });

  it("charges two registrations only for an empty active registry", () => {
    assert.equal(fundingRequirement({ registrationFeeWei: 10n, activeKeyIds: [], relayGasHeadroomWei: 30n, balanceWei: 100n, observedAtSec: 7 }).requiredWei, "50");
    assert.equal(fundingRequirement({ registrationFeeWei: 10n, activeKeyIds: [KEY_ID], relayGasHeadroomWei: 30n, balanceWei: 100n, observedAtSec: 7 }).requiredWei, "40");
  });
});

describe("KeyDoesNotExist revert classification (2026-09-03 live hire incident)", () => {
  // Measured on wallet 0x2714…9da6: `canExecute(ungrantedHash, …)` reverts
  // 0xe57b6304 = keccak("KeyDoesNotExist()"). Escaping, it made every fresh
  // hire `evidence-unreadable` and therefore never offered the grant.
  it("pins the selector to the error's own signature", () => {
    assert.equal(KEY_DOES_NOT_EXIST_SELECTOR, keccak256(stringToBytes("KeyDoesNotExist()")).slice(0, 10));
  });

  it("recognises the revert as viem reports it: raw signature, raw data, decoded name, nested cause", () => {
    assert.equal(isKeyDoesNotExistRevert({ signature: "0xe57b6304" }), true);
    assert.equal(isKeyDoesNotExistRevert({ data: "0xE57B6304" }), true);
    assert.equal(isKeyDoesNotExistRevert({ data: { errorName: "KeyDoesNotExist" } }), true);
    assert.equal(isKeyDoesNotExistRevert({ message: "outer", cause: { message: "inner", cause: { signature: "0xe57b6304" } } }), true);
    assert.equal(isKeyDoesNotExistRevert(new Error("The contract function \"canExecute\" reverted with the following signature:\n0xe57b6304")), true);
  });

  it("does not swallow anything else — other reverts, transport failures, junk", () => {
    assert.equal(isKeyDoesNotExistRevert({ signature: "0x08c379a0" }), false);
    assert.equal(isKeyDoesNotExistRevert({ data: { errorName: "Unauthorized" } }), false);
    assert.equal(isKeyDoesNotExistRevert(new Error("HTTP request failed. URL: https://rpc timeout")), false);
    assert.equal(isKeyDoesNotExistRevert(null), false);
    assert.equal(isKeyDoesNotExistRevert("0xe57b6304"), false);
    const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
    assert.equal(isKeyDoesNotExistRevert(cyclic), false);
  });
});

it("69-token persisted trade evidence requires exact permissions and keeps unrelated64 bounds", () => {
  const tokens = Array.from({length:69},(_,i)=>getAddress(`0x${(100+i).toString(16).padStart(40,"0")}`));
  const calls = [...tokens.map(to=>({to,signature:"approve(address,uint256)"})),...Array.from({length:5},(_,i)=>({to:getAddress(`0x${(500+i).toString(16).padStart(40,"0")}`),signature:"transfer(address,uint256)"}))];
  const spend = [{period:"day" as const,limit:1n},...tokens.map(token=>({token,period:"day" as const,limit:1n}))];
  const permissions69 = {calls,spend};
  const draft: PendingGrant = {...pending(),permissions:permissions69,sizing:{...pending().sizing,sizingPreset:"trade-v1"}};
  const relayCalls = [...calls.map(row=>({...row,signature:toFunctionSelector(row.signature)})),{to:getAddress("0xaf140d0416a994aebb3fa6212b16ce6700f09751"),signature:"0x32323232"}];
  const evidence: GrantEvidenceSnapshot={...exactEvidence(),relayKeys:[{...exactEvidence().relayKeys[0]!,permissions:{calls:relayCalls,spend}}],accountSpend:spend,canExecute:relayCalls.map(()=>true)};
  assert.deepEqual(assessGrantEvidence(draft,evidence,1000),[]);
  assert.throws(()=>normalizeGrantPermissions({kind:"persisted",value:permissions69}));
  assert.deepEqual(assessGrantEvidence({...draft,sizing:pending().sizing},evidence,1000),["evidence-unreadable"]);
  const extra={...evidence,relayKeys:[{...evidence.relayKeys[0]!,permissions:{calls:[...relayCalls,{to:TOKEN,signature:"0xdeadbeef"}],spend}}]};
  assert.deepEqual(assessGrantEvidence(draft,extra,1000),["evidence-unreadable"]);
  assert.deepEqual(assessGrantEvidence(draft,{...evidence,relayKeys:[{...evidence.relayKeys[0]!,permissions:{calls:relayCalls.slice(1),spend}}]},1000),["permissions-differ"]);
  assert.deepEqual(assessGrantEvidence(draft,{...evidence,canExecute:evidence.canExecute.slice(1)},1000),["permissions-differ"]);
  assert.deepEqual(assessGrantEvidence(draft,{...evidence,accountSpend:[...spend,{token:TOKEN,period:"day",limit:1n}]},1000),["evidence-unreadable"]);
  assert.deepEqual(assessGrantEvidence(draft,{...evidence,relayKeys:[{...evidence.relayKeys[0]!,permissions:{calls:[...relayCalls,...Array(6).fill({to:TOKEN,signature:"0xdeadbeef"})],spend}}]},1000),["evidence-unreadable"]);
});

it("public grant reader probes all69 approvals plus implicit orchestrator from persisted trade context",async()=>{
  const tokens=Array.from({length:69},(_,i)=>getAddress(`0x${(100+i).toString(16).padStart(40,"0")}`));
  const draft:PendingGrant={...pending(),permissions:{calls:[...tokens.map(to=>({to,signature:"approve(address,uint256)"})),...Array.from({length:5},(_,i)=>({to:getAddress(`0x${(500+i).toString(16).padStart(40,"0")}`),signature:"transfer(address,uint256)"}))],spend:[{period:"day",limit:1n},...tokens.map(token=>({token,period:"day" as const,limit:1n}))]},sizing:{...pending().sizing,sizingPreset:"trade-v1"}};
  const probes:string[]=[];const fetchBefore=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({jsonrpc:"2.0",id:0,result:{"0x38":[]}});
  try {
    const reader=createGrantEvidenceReader({network:{chain:bsc,chainId:56,publicRpcUrl:"https://fixture.invalid",keyStoreController:TOKEN},
      keyStoreReader:{async listKeys(){return []},async publicKeyFor(){return "0x"}},
      transport:()=>custom({async request({method,params}){
        if(method==="eth_chainId") return "0x38";
        if(method==="eth_getCode") return "0x01";
        if(method==="eth_call") {
          const rows=params as readonly {data?:string}[]; const data=rows[0]?.data??"";
          if(data.startsWith(toFunctionSelector("canExecute(bytes32,address,bytes)"))) { probes.push(data); return encodeFunctionResult({abi:ACCOUNT_ABI,functionName:"canExecute",result:true}); }
          if(data.startsWith(toFunctionSelector("getKeys()"))) return encodeFunctionResult({abi:ACCOUNT_ABI,functionName:"getKeys",result:[[],[]]});
          if(data.startsWith(toFunctionSelector("spendInfos(bytes32)"))) return encodeFunctionResult({abi:ACCOUNT_ABI,functionName:"spendInfos",result:[]});
          throw Error("unexpected account call");
        }
        throw Error("unexpected fixture RPC");
      }},{retryCount:0})});
    // Await the complete reader so no relay operation survives fetch restoration.
    const observed = await reader.readGrant(draft);
    assert.equal(observed.canExecute.length,75);
    assert.equal(probes.length,75);
    assert.ok(probes.some(data=>data.toLowerCase().includes(tokens[68]!.slice(2).toLowerCase())));
    probes.length=0;
    await assert.rejects(reader.readGrant({...draft,sizing:pending().sizing}));assert.equal(probes.length,0);
  } finally {globalThis.fetch=fetchBefore;}
});
