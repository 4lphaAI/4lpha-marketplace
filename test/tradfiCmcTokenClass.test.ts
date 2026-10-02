/**
 * CMC-TOKEN-CLASS-SPEC: the capability gate matches a bStock as a member of a
 * reviewed proxy/beacon/implementation class, so a new pinned token set never
 * needs its own probe re-run (F1). Covers the V2 digest, the class-membership
 * reader, the V1-then-V2 reader flow and the version-scoped registry lookup.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import {
  CMC_APPROVE_SIGNATURE, CMC_PERMIT2, CmcProfileUnavailableError,
  grantShapeDigestV1, grantShapeDigestV2,
  type CmcGrantShapeSpec, type CmcMatrixFacts, type CmcReviewedProfile, type CmcReviewedTokenClass,
} from "../src/trade/cmcCapability.js";
import { cmcTokenClassCandidates, createCmcRpcCapabilityReader, readCmcTokenClassMembers, type CmcMatrixTrace, type CmcMatrixTraceRequest } from "../src/trade/cmcRpc.js";
import { createCmcRuntimeProfileRegistry } from "../src/trade/cmcRuntime.js";
import { USDT_56 } from "../src/trade/settlement.js";

function nthAddress(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, "0")}`);
}

function specFor(bstocks: readonly Address[], router: Address, extra: CmcGrantShapeSpec["allowedCalls"] = []): CmcGrantShapeSpec {
  return {
    allowedCalls: [{ to: router }, ...bstocks.map((token) => ({ to: token, selector: CMC_APPROVE_SIGNATURE })), ...extra],
    spendCaps: [{ token: USDT_56 }, ...bstocks.map((token) => ({ token }))],
  };
}

function classedOf(bstocks: readonly Address[]): ReadonlySet<string> {
  return new Set(bstocks.map((token) => token.toLowerCase()));
}

test("V2 equalities: different classed bStock sets, including one with no class-B member, give an equal V2 digest", () => {
  const router = nthAddress(99);
  const small = [nthAddress(1), nthAddress(2), nthAddress(3)];
  const large = [nthAddress(11), nthAddress(12), nthAddress(13), nthAddress(14), nthAddress(15)];
  const digestSmall = grantShapeDigestV2(specFor(small, router), classedOf(small));
  const digestLarge = grantShapeDigestV2(specFor(large, router), classedOf(large));
  assert.equal(digestSmall, digestLarge);
});

test("V2 inequalities: an unclassed replacement, an extra non-approve rule, USDT never classed, and version separate V1 from V2", () => {
  const router = nthAddress(99);
  const bstocks = [nthAddress(1), nthAddress(2), nthAddress(3)];
  const classed = classedOf(bstocks);
  const base = grantShapeDigestV2(specFor(bstocks, router), classed);

  // Replacing a classed bStock with an unclassed address changes the shape.
  const swapped = [...bstocks.slice(0, 2), nthAddress(4)];
  assert.notEqual(grantShapeDigestV2(specFor(swapped, router), classed), base);

  // A classed address that also carries a non-approve rule stays exact under its own address.
  const withExtraSelector = specFor(bstocks, router, [{ to: bstocks[0]!, selector: "transfer(address,uint256)" }]);
  assert.notEqual(grantShapeDigestV2(withExtraSelector, classed), base);

  // USDT is never a class candidate, even when it carries an approve rule and a cap.
  const withUsdtApprove: CmcGrantShapeSpec = {
    allowedCalls: [...specFor(bstocks, router).allowedCalls, { to: USDT_56, selector: CMC_APPROVE_SIGNATURE }],
    spendCaps: specFor(bstocks, router).spendCaps,
  };
  const candidates = cmcTokenClassCandidates(withUsdtApprove);
  assert.ok(!candidates.some((address) => address.toLowerCase() === USDT_56.toLowerCase()));

  // For the same spec with an empty classed set, V2 never equals V1 (the encoded `version` differs).
  const v1 = grantShapeDigestV1(specFor(bstocks, router));
  const v2Empty = grantShapeDigestV2(specFor(bstocks, router), new Set());
  assert.notEqual(v2Empty, v1);
});

/* ---------------------------------------------- readCmcTokenClassMembers */

const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const BLOCK = 123_456n;
const PROXY_CODE: Hex = "0x600160005260206000f3";
const BEACON_CODE: Hex = "0x600260005260206000f3";
const IMPLEMENTATION_CODE: Hex = "0x600360005260206000f3";
const OTHER_CODE: Hex = "0x600460005260206000f3";
const BEACON = getAddress("0x2222222222222222222222222222222222222222");
const IMPLEMENTATION = getAddress("0x3333333333333333333333333333333333333333");
const WRONG_BEACON = getAddress("0x4444444444444444444444444444444444444444");
const WRONG_IMPLEMENTATION = getAddress("0x5555555555555555555555555555555555555555");

const TEST_CLASS: CmcReviewedTokenClass = {
  classId: "test-class",
  proxyCodeHash: keccak256(PROXY_CODE),
  beacon: BEACON,
  beaconCodeHash: keccak256(BEACON_CODE),
  implementation: IMPLEMENTATION,
  implementationCodeHash: keccak256(IMPLEMENTATION_CODE),
  provenBy: "test fixture",
};

function slotValue(address: Address): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

function fakeMemberClient(overrides: {
  readonly proxyCode?: Hex;
  readonly beaconSlotAddress?: Address;
  readonly beaconCode?: Hex;
  readonly implementationResult?: Address;
  readonly implementationCode?: Hex;
  readonly throwOn?: "getCode" | "getStorageAt" | "readContract";
} = {}, blockNumbersSeen: bigint[] = []) {
  const beaconSlotAddress = overrides.beaconSlotAddress ?? BEACON;
  const implementationResult = overrides.implementationResult ?? IMPLEMENTATION;
  const codeByAddress = new Map<string, Hex>([
    [TOKEN.toLowerCase(), overrides.proxyCode ?? PROXY_CODE],
    [BEACON.toLowerCase(), overrides.beaconCode ?? BEACON_CODE],
    [IMPLEMENTATION.toLowerCase(), overrides.implementationCode ?? IMPLEMENTATION_CODE],
  ]);
  return {
    async getCode(input: { readonly address: Address; readonly blockNumber?: bigint }): Promise<Hex | undefined> {
      blockNumbersSeen.push(input.blockNumber!);
      if (overrides.throwOn === "getCode") throw new Error("rpc down");
      return codeByAddress.get(input.address.toLowerCase()) ?? "0x";
    },
    async getStorageAt(input: { readonly address: Address; readonly slot: Hex; readonly blockNumber?: bigint }): Promise<Hex | undefined> {
      blockNumbersSeen.push(input.blockNumber!);
      if (overrides.throwOn === "getStorageAt") throw new Error("rpc down");
      return input.address.toLowerCase() === TOKEN.toLowerCase() ? slotValue(beaconSlotAddress) : `0x${"00".repeat(32)}`;
    },
    async readContract(input: { readonly blockNumber?: bigint }): Promise<unknown> {
      blockNumbersSeen.push(input.blockNumber!);
      if (overrides.throwOn === "readContract") throw new Error("rpc down");
      return implementationResult;
    },
  };
}

test("readCmcTokenClassMembers: a full match yields the member, and every read receives the passed blockNumber", async () => {
  const seen: bigint[] = [];
  const client = fakeMemberClient({}, seen);
  const members = await readCmcTokenClassMembers(client, [TOKEN], BLOCK, [TEST_CLASS]);
  assert.equal(members.get(TOKEN.toLowerCase()), TEST_CLASS.classId);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((value) => value === BLOCK));
});

test("readCmcTokenClassMembers: a mismatch on any single check yields no member", async () => {
  const cases: Record<string, Parameters<typeof fakeMemberClient>[0]> = {
    "proxy code": { proxyCode: OTHER_CODE },
    "beacon slot": { beaconSlotAddress: WRONG_BEACON },
    "beacon code": { beaconCode: OTHER_CODE },
    "implementation()": { implementationResult: WRONG_IMPLEMENTATION },
    "implementation code": { implementationCode: OTHER_CODE },
  };
  for (const [label, overrides] of Object.entries(cases)) {
    const client = fakeMemberClient(overrides);
    const members = await readCmcTokenClassMembers(client, [TOKEN], BLOCK, [TEST_CLASS]);
    assert.equal(members.size, 0, `expected no member for a ${label} mismatch`);
  }
});

test("readCmcTokenClassMembers: a thrown RPC error rejects", async () => {
  const client = fakeMemberClient({ throwOn: "getCode" });
  await assert.rejects(() => readCmcTokenClassMembers(client, [TOKEN], BLOCK, [TEST_CLASS]));
});

/* --------------------------------------------------- reader: V1-then-V2 */

const WALLET = getAddress("0x6666666666666666666666666666666666666666");
const KEY = `0x04${"33".repeat(64)}` as Hex;
const H = `0x${"44".repeat(32)}` as Hex;
const ABI = parseAbi([
  "function getKeys() view returns ((uint40 expiry,uint8 keyType,bool isSuperAdmin,bytes publicKey)[] keys,bytes32[] keyHashes)",
  "function approvedSignatureCheckers(bytes32 keyHash) view returns(address[])",
  "function allowance(address owner,address spender) view returns(uint256)",
  "function implementation() view returns(address)",
]);

// The real reader always classifies against the shipped `CMC_REVIEWED_TOKEN_CLASSES`
// (matching against those real proxy/beacon/implementation code hashes is exercised
// directly by the `readCmcTokenClassMembers` tests above with an injected fixture
// class). Here `TOKEN` never matches a shipped class, so the V2 fallback always
// resolves an empty membership set — enough to exercise the V1-miss-then-V2 flow.
function readerFixture(input: { readonly onStorageAt?: () => void } = {}): typeof fetch {
  const currentHash = accountKeyHashForAddress(publicKeyToAddress(KEY));
  const now = Math.floor(Date.now() / 1_000);
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { readonly id: number; readonly method: string; readonly params: readonly unknown[] };
    let result: unknown;
    if (request.method === "eth_chainId") result = "0x38";
    else if (request.method === "eth_getBlockByNumber" || request.method === "eth_getBlockByHash") {
      result = { number: "0x64", hash: H, timestamp: `0x${now.toString(16)}`, transactions: [] };
    } else if (request.method === "eth_getCode") {
      result = "0x6000";
    } else if (request.method === "eth_getStorageAt") {
      input.onStorageAt?.();
      result = `0x${"00".repeat(32)}`;
    } else if (request.method === "eth_call") {
      const call = request.params[0] as { readonly data: Hex };
      const decoded = decodeFunctionData({ abi: ABI, data: call.data });
      if (decoded.functionName === "getKeys") {
        result = encodeFunctionResult({ abi: ABI, functionName: "getKeys", result: [[
          { expiry: now + 10_000, keyType: 2, isSuperAdmin: false, publicKey: KEY },
        ], [currentHash]] });
      } else if (decoded.functionName === "allowance") {
        result = encodeFunctionResult({ abi: ABI, functionName: "allowance", result: 0n });
      } else if (decoded.functionName === "implementation") {
        result = encodeFunctionResult({ abi: ABI, functionName: "implementation", result: IMPLEMENTATION });
      } else {
        result = encodeFunctionResult({ abi: ABI, functionName: "approvedSignatureCheckers", result: [] });
      }
    } else throw new Error(`unexpected RPC ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
  };
}

const TRACE_FACTS: Omit<CmcMatrixFacts, "proofDigests"> = {
  ownerApprovalPersists: true, unrelatedTradingPreservesAllowance: true,
  sessionApproveCannotIncreaseAllowance: true, noTemporaryApproveConsumePath: true,
  temporaryApproveCallbackReentryExcluded: true, revokeExpiryRejectsPayment: true,
  walletKeyExclusive: true, additiveIncreaseAllowance: true,
};

test("reader: a V1 hit makes zero class reads", async (context) => {
  let storageAtCalls = 0;
  context.mock.method(globalThis, "fetch", readerFixture({ onStorageAt: () => { storageAtCalls += 1; } }));
  const SPEC = { allowedCalls: [{ to: TOKEN, selector: CMC_APPROVE_SIGNATURE }], spendCaps: [{ token: TOKEN }] };
  const calls: CmcMatrixTraceRequest[] = [];
  const reader = createCmcRpcCapabilityReader({
    rpcUrl: "https://cmc-token-class.invalid",
    sessionSpec: async () => SPEC,
    matrixTrace: async (request): Promise<CmcMatrixTrace | null> => {
      calls.push(request);
      return { ...TRACE_FACTS, proofDigests: [H], grantShapeDigest: request.grantShapeDigest, profileId: "v1-fixture" };
    },
  });
  const evidence = await reader.read({ agentId: "a", wallet: WALLET, sessionPublicKey: KEY, generation: 0 });
  assert.ok(evidence);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.grantShapeVersion, 1);
  assert.equal(storageAtCalls, 0);
});

test("reader: a V1 miss with a V2 hit gives evidence at the local V2 digest", async (context) => {
  context.mock.method(globalThis, "fetch", readerFixture());
  const SPEC = { allowedCalls: [{ to: TOKEN, selector: CMC_APPROVE_SIGNATURE }], spendCaps: [{ token: TOKEN }] };
  const calls: CmcMatrixTraceRequest[] = [];
  const reader = createCmcRpcCapabilityReader({
    rpcUrl: "https://cmc-token-class.invalid",
    sessionSpec: async () => SPEC,
    matrixTrace: async (request): Promise<CmcMatrixTrace | null> => {
      calls.push(request);
      if (request.grantShapeVersion === 1) return null;
      return { ...TRACE_FACTS, proofDigests: [H], grantShapeDigest: request.grantShapeDigest, profileId: "v2-fixture" };
    },
  });
  const evidence = await reader.read({ agentId: "a", wallet: WALLET, sessionPublicKey: KEY, generation: 0 });
  assert.ok(evidence);
  // TOKEN matches no shipped reviewed class here (see readerFixture), so the local
  // V2 digest is computed with an empty membership set.
  const expectedV2 = grantShapeDigestV2(SPEC, new Set());
  assert.equal(evidence.grantShapeDigest, expectedV2);
  assert.equal(evidence.profileId, "v2-fixture");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.grantShapeVersion, 1);
  assert.equal(calls[1]?.grantShapeVersion, 2);
});

test("reader: both missing gives the gate reason cmc-profile-unavailable", async (context) => {
  context.mock.method(globalThis, "fetch", readerFixture());
  const SPEC = { allowedCalls: [{ to: TOKEN, selector: CMC_APPROVE_SIGNATURE }], spendCaps: [{ token: TOKEN }] };
  const reader = createCmcRpcCapabilityReader({
    rpcUrl: "https://cmc-token-class.invalid",
    sessionSpec: async () => SPEC,
    matrixTrace: async (): Promise<CmcMatrixTrace | null> => null,
  });
  await assert.rejects(() => reader.read({ agentId: "a", wallet: WALLET, sessionPublicKey: KEY, generation: 0 }), CmcProfileUnavailableError);
});

test("reader: a V2 trace returning a different digest gives no evidence", async (context) => {
  // R-2 keeps the existing V1 path unchanged (see the `audit.tradfiCmcFixes.test.ts`
  // and `tradfiCmcRuntime.test.ts` fixtures, which return a trace unconditionally
  // without regard to the requested digest): the digest cross-check is new
  // behaviour scoped to the class-based V2 fallback, which is fresh in this build.
  context.mock.method(globalThis, "fetch", readerFixture());
  const SPEC = { allowedCalls: [{ to: TOKEN, selector: CMC_APPROVE_SIGNATURE }], spendCaps: [{ token: TOKEN }] };
  const reader = createCmcRpcCapabilityReader({
    rpcUrl: "https://cmc-token-class.invalid",
    sessionSpec: async () => SPEC,
    matrixTrace: async (request): Promise<CmcMatrixTrace | null> => {
      if (request.grantShapeVersion === 1) return null;
      return { ...TRACE_FACTS, proofDigests: [H], grantShapeDigest: `0x${"cd".repeat(32)}` as Hex, profileId: "mismatched-fixture" };
    },
  });
  const evidence = await reader.read({ agentId: "a", wallet: WALLET, sessionPublicKey: KEY, generation: 0 });
  assert.equal(evidence, null);
});

/* ------------------------------------------------------------- registry */

test("registry: a version-2 profile never matches a version-1 lookup at the same digest, and vice versa", () => {
  const digest = `0x${"ab".repeat(32)}` as Hex;
  const matrix: CmcMatrixFacts = { ...TRACE_FACTS, proofDigests: [digest] };
  const v1Row: CmcReviewedProfile = { profileId: "v1-row", chainId: 56, accountCodeHash: digest, tokenCodeHash: digest,
    permit2CodeHash: digest, settlerCodeHash: digest, checker: CMC_PERMIT2, grantShapeDigest: digest, evidenceDigest: digest, matrix };
  const v2Row: CmcReviewedProfile = { ...v1Row, profileId: "v2-row", grantShapeVersion: 2 };
  const registry = createCmcRuntimeProfileRegistry([v1Row, v2Row]);
  const identity = { accountCodeHash: digest, tokenCodeHash: digest, permit2CodeHash: digest, settlerCodeHash: digest, grantShapeDigest: digest };
  assert.equal(registry.find({ ...identity, grantShapeVersion: 1 })?.profileId, "v1-row");
  assert.equal(registry.find({ ...identity, grantShapeVersion: 2 })?.profileId, "v2-row");
});
