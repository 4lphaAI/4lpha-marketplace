/** Runtime capability gate for the CMC Permit2 payment rail. */
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { canonicalEncode } from "../auth/canonical.js";
import type { CmcBudgetStore } from "../store/tradeCmc.js";

export const CMC_CAPABILITY_KIND = "cmc-mainnet-capability-v1" as const;
/**
 * MEASURED 2026-09-20 (first live owner setup, G1): the owner prepare stamps
 * `nowMs` BEFORE the gate runs, and the live reader stamps `observedAtMs`
 * after ~1 s of finalized RPC reads, so the strict "not from the future" check
 * refused every real wallet with `cmc-capability-matrix-unproven` while every
 * fixture (static clocks) passed. Evidence may lead the caller's clock by this
 * much; anything further ahead is still refused.
 */
export const CMC_EVIDENCE_FUTURE_SKEW_MS = 60_000;
export const CMC_PERMIT2: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
export const CMC_TOKEN_CLASS_TAG = "reviewed-token-class";
export const CMC_APPROVE_SIGNATURE = "approve(address,uint256)";

/**
 * A bStock proxy shape proven, by a live matrix run against ONE member, to
 * carry no bStock-address-dependent behaviour (CMC-TOKEN-CLASS-SPEC §2 F2).
 * `provenBy` cites the matrix fixture; adding a class is a reviewed edit, not
 * an auto-discovery.
 */
export type CmcReviewedTokenClass = {
  readonly classId: string;
  readonly proxyCodeHash: Hex;
  readonly beacon: Address;
  readonly beaconCodeHash: Hex;
  readonly implementation: Address;
  readonly implementationCodeHash: Hex;
  readonly provenBy: string;
};

/** CMC-TOKEN-CLASS-SPEC §2 F2, measured 2026-09-23/24. */
export const CMC_REVIEWED_TOKEN_CLASSES: readonly CmcReviewedTokenClass[] = [
  {
    classId: "bstock-beacon-a",
    proxyCodeHash: "0xdf946913977a2ed76735b4b2e66f2272d1a76af911c4e520655888c9e32269f9",
    beacon: getAddress("0x156d6dce9a4f6139a3406f1f021f1a4880de93a3"),
    beaconCodeHash: "0x80fbad22136c0abdce6e0f3cc46cd0572318e01b92dbd5b4d5795ef6e8808711",
    implementation: getAddress("0xCFEd6c4679297ea4889F8183bC057B4A86C64e46"),
    implementationCodeHash: "0x060dc28d4dd8d9bb8a381d4009bccbac129ce743a10b3d8aa0ffef5034b50544",
    provenBy: "CMC-MATRIX-123610834 (tradfi-agent-0107007, 8/8 PASS; 20 bstock-beacon-a + 8 bstock-beacon-b members)",
  },
  {
    classId: "bstock-beacon-b",
    proxyCodeHash: "0x439923c85f956f038ae77871736f789e6d08d22257b6e5fdccfdc83924ecb4d0",
    beacon: getAddress("0xc046b05a920e4b412815934dd8e58904dda73315"),
    beaconCodeHash: "0x90d14c8f8d7d3468b5215829b587058c5e7f78acaef6b946c20caa3de92bf410",
    implementation: getAddress("0x578f397CA4661D1dB4D9a65065D6B284A1A850fd"),
    implementationCodeHash: "0x85d44c72e84a34f0b4a3bceca35289b10bd0c5510c5a441466a755e903edc36a",
    provenBy: "CMC-MATRIX-123610834 (tradfi-agent-0107007, 8/8 PASS; 20 bstock-beacon-a + 8 bstock-beacon-b members)",
  },
];

export type CmcMatrixFacts = {
  readonly ownerApprovalPersists: true;
  readonly unrelatedTradingPreservesAllowance: true;
  /**
   * A session approve alone cannot persist a HIGHER allowance (it may zero it
   * — availability residual, not a spend path).
   */
  readonly sessionApproveCannotIncreaseAllowance: true;
  readonly noTemporaryApproveConsumePath: true;
  readonly temporaryApproveCallbackReentryExcluded: true;
  readonly revokeExpiryRejectsPayment: true;
  readonly walletKeyExclusive: true;
  readonly additiveIncreaseAllowance: true;
  readonly proofDigests: readonly Hex[];
};

export type CmcCapabilityEvidence = CmcMatrixFacts & {
  readonly kind: typeof CMC_CAPABILITY_KIND;
  readonly source: "live-mainnet";
  readonly chainId: 56;
  readonly wallet: Address;
  readonly accountCodeHash: Hex;
  readonly tokenCodeHash: Hex;
  readonly permit2CodeHash: Hex;
  readonly settlerCodeHash: Hex;
  readonly sessionPublicKey: Hex;
  readonly checker: Address;
  readonly finiteAllowanceWei: bigint;
  readonly grantShapeDigest: Hex;
  readonly observedAtMs: number;
  readonly profileId: string;
  readonly generation: number;
  readonly checkerApproved: boolean;
};

/**
 * Profiles are source-reviewed, content-bound IMPLEMENTATION identities. The
 * eight matrix facts are properties of the account implementation, the token,
 * Permit2, the settler and the grant SHAPE — never of one wallet address, so a
 * profile carries no wallet. Every per-wallet fact (allowance, checker
 * approval, key liveness/exclusivity, session expiry) stays live in the reader.
 * The empty registry is intentional until a real matrix is captured and
 * reviewed; evidence JSON cannot add a production capability by itself.
 */
export type CmcReviewedProfile = {
  readonly profileId: string;
  readonly chainId: 56;
  readonly accountCodeHash: Hex;
  readonly tokenCodeHash: Hex;
  readonly permit2CodeHash: Hex;
  readonly settlerCodeHash: Hex;
  readonly checker: Address;
  readonly grantShapeDigest: Hex;
  readonly evidenceDigest: Hex;
  /** Absent means 1 (the exact per-address shape). 2 is the reviewed-token-class shape. */
  readonly grantShapeVersion?: 2;
  /** Source-bound matrix facts consumed by runtime wiring; absent profiles cannot activate. */
  readonly matrix: CmcMatrixFacts;
};
/**
 * One row, from the matrix executed on an Anvil fork of BSC mainnet at block
 * 122 915 340 (`scripts/cmc-matrix-probe.ts`, `MD here/CMC-MATRIX-122915340.json`):
 * 8/8 PASS. Operator ruling 2026-09-20: fact #3 is the R2.5 contract — a
 * session approve alone cannot persist a HIGHER allowance — and the measured
 * in-cap `USDT.approve(Permit2, …)` leaves the owner's allowance at 0, i.e.
 * lower, so it passes. Residual (availability, not custody): a compromised
 * trading key or a worker bug can WIPE that data allowance; the owner tops it
 * up again and trading capital is untouched.
 */
export const CMC_REVIEWED_PROFILES: readonly CmcReviewedProfile[] = [
  {
    profileId: "altana-c0f16888-v2grant-v1",
    chainId: 56,
    accountCodeHash: "0x2f17b34a1c33b5fb9bd06422cec6782b367aa0e0bb09ee3c5263b14f4112a00f",
    tokenCodeHash: "0x97a48aa4c129657440dafdacd4c836389734d28cc4a0ca7403e68da660a74a59",
    permit2CodeHash: "0x48774d936722dd7002887f307f58bcddb3eeabad39149e7dcb5c08e4ebe3310f",
    settlerCodeHash: "0x0ba2481269cc11da9a6208fb34ea1c04cc05152551660b94465f65920b05bb71",
    checker: CMC_PERMIT2,
    grantShapeDigest: "0x86dce5f53fb4ad5a4c810fd0a8d8cf6613bff7458f7e5a581ead835395390067",
    evidenceDigest: "0xc5a1f6ab7b56b41e371426b3df335229259e746289be6abb4c27f1af730ad52d",
    matrix: {
      ownerApprovalPersists: true,
      unrelatedTradingPreservesAllowance: true,
      sessionApproveCannotIncreaseAllowance: true,
      noTemporaryApproveConsumePath: true,
      temporaryApproveCallbackReentryExcluded: true,
      revokeExpiryRejectsPayment: true,
      walletKeyExclusive: true,
      additiveIncreaseAllowance: true,
      proofDigests: [
        "0xad84ce8a9b34558a5e837c80859389d37a7d5b6f4af0ebb8c4fe5539b3ce35da",
        "0xef782221101dbb3ee171a0cd270afb7fea976dcf22d12110dacbd4863c9e8327",
        "0xff812f23cca8015dbd6a36dca4cf889b0fff5c26e254ca4f33d2765745631053",
        "0x0bfeff4474f67bc79f464f5d9d0b84e43fe92dfc3af4278599944cc56401409e",
        "0x29af6875f06d915358ad0985b2ef285934cb65b925345c31b170bff0eac71a4b",
        "0xc9d379ad4394a1de11243175d85322575907c39b237f48b3467f0ef9268d4b37",
        "0xbdfa68a91e9e1ad2f539326c44d1effb87f717a6ae6ed3d92132dc8949a44ab2",
        "0x94088860700eb5ee4d5b631be50c6c5d5927d25e449a44324ffaa5385d8227c7",
      ],
    },
  },
  {
    // Second reviewed profile, 2026-09-22: the V3 hire pins a different token
    // set (30 tokens / 38 rules), so the grant shape digest differs while the
    // account, USDT, Permit2 and settler code hashes are byte-identical to the
    // first profile. Matrix re-run on fork block 123226705
    // (`MD here/CMC-MATRIX-123226705.md`), 8/8 PASS, with the allowance facts
    // measured relative to the wallet's prior Permit2 allowance (re-hired wallet).
    profileId: "altana-c0f16888-v3grant-v1",
    chainId: 56,
    accountCodeHash: "0x2f17b34a1c33b5fb9bd06422cec6782b367aa0e0bb09ee3c5263b14f4112a00f",
    tokenCodeHash: "0x97a48aa4c129657440dafdacd4c836389734d28cc4a0ca7403e68da660a74a59",
    permit2CodeHash: "0x48774d936722dd7002887f307f58bcddb3eeabad39149e7dcb5c08e4ebe3310f",
    settlerCodeHash: "0x0ba2481269cc11da9a6208fb34ea1c04cc05152551660b94465f65920b05bb71",
    checker: CMC_PERMIT2,
    grantShapeDigest: "0xc0eda9697b4e7f72398cf77cab39171504d73d8ae142b8bf466e4cfa8d5bdc20",
    evidenceDigest: "0x75a5015d2bb70ecec3ae00315e096f000f1daf3b0231216da1db354f8f571e3b",
    matrix: {
      ownerApprovalPersists: true,
      unrelatedTradingPreservesAllowance: true,
      sessionApproveCannotIncreaseAllowance: true,
      noTemporaryApproveConsumePath: true,
      temporaryApproveCallbackReentryExcluded: true,
      revokeExpiryRejectsPayment: true,
      walletKeyExclusive: true,
      additiveIncreaseAllowance: true,
      proofDigests: [
        "0xa154d63c09664ac0a3074a778e2fada813df1ea657394c46a7eb23c5bfd0bf64",
        "0x86f17db02daefc339a44f81ba713d279e3053e675466e376bc0d64e48ff9e88f",
        "0xc339cf2248afa410e6950d2fb437c882112694cb6e78340f203a371fffab49a5",
        "0x604769e78c65354e6f760eaa512a2e971d584fe88903d6e96aa82ff0ef37763c",
        "0x024d1b4b1dd6004ad8aa7c916edf92b63ebf2055d67400e580b965f5d5d7d02c",
        "0xb5cc76c5341ffe82501a85cd04b5f6067aa5ad609de4055cb8c537000565c6d5",
        "0xb4658fd7f337a65a5f8408b161bfdcf26c982bdbd2b6464811249701190161f0",
        "0xf45d35268cda101a2d7896aced887f95b578d3aeb78ab80a63faeaf8ffab6b70",
      ],
    },
  },
  {
    // Third reviewed profile, 2026-09-23: the aggregator activation (6735bd2)
    // adds the TradFi guard rule to the grant, so the grant shape digest differs
    // while the four code hashes are byte-identical to the V3 profile. Matrix
    // re-run for `tradfi-agent-0107007` on fork block 123599459
    // (`MD here/CMC-MATRIX-123599459.md`), 8/8 PASS; trace #4 enumerated the new
    // guard rule and found no allowlisted target that can pull USDT via Permit2.
    profileId: "altana-c0f16888-aggregator-v1",
    chainId: 56,
    accountCodeHash: "0x2f17b34a1c33b5fb9bd06422cec6782b367aa0e0bb09ee3c5263b14f4112a00f",
    tokenCodeHash: "0x97a48aa4c129657440dafdacd4c836389734d28cc4a0ca7403e68da660a74a59",
    permit2CodeHash: "0x48774d936722dd7002887f307f58bcddb3eeabad39149e7dcb5c08e4ebe3310f",
    settlerCodeHash: "0x0ba2481269cc11da9a6208fb34ea1c04cc05152551660b94465f65920b05bb71",
    checker: CMC_PERMIT2,
    grantShapeDigest: "0x29e79165599f6db168d4b4c6e56cb24ec602ae5576af6e49c88e4c00d60bee9d",
    evidenceDigest: "0x7c7c9594f1aaeeba896f030897a229b1c9c50ba5c707f2e9184729450329e801",
    matrix: {
      ownerApprovalPersists: true,
      unrelatedTradingPreservesAllowance: true,
      sessionApproveCannotIncreaseAllowance: true,
      noTemporaryApproveConsumePath: true,
      temporaryApproveCallbackReentryExcluded: true,
      revokeExpiryRejectsPayment: true,
      walletKeyExclusive: true,
      additiveIncreaseAllowance: true,
      proofDigests: [
        "0x85f3235f294c651752c86409adc52bd486c06a8d248552d38ebaa52b4d2951eb",
        "0x7ed4b6a7eb7c25f0bde7909a89a38668a46c41ea6630a2a3fd2733784e0cb8a4",
        "0xb2bd13414e3a4ee19d050a4c0e9c8b2ea7901fcbad88d80c3ddfcd1aef022173",
        "0xa915fa96ad89cd49ff59151cbd0bfbefd6be9af4bdb70e072b27e511504e98cc",
        "0x200d07878c15016219a6de6ed593d4e9a1f21cf1a93c29bfa046137fca565542",
        "0xafe50d7b3987bf0bd3608054ece5722a14f3cdedc38d1d006d60acf0f5a429bf",
        "0xa58384c73e0a8f645eb6d4a19f3cadbdbc488cc703fe376239c8c5798734c288",
        "0x26e247543adff5ce0723061def8c5e94cd4e81c1cf637c5492bf1429d750c009",
      ],
    },
  },
  {
    // Fourth reviewed profile (CMC-TOKEN-CLASS G0, 2026-09-24): the aggregator
    // grant with every pinned bStock collapsed into the reviewed token class
    // (grant shape V2). Matrix re-run for `tradfi-agent-0107007` on fork block
    // 123610834 (`MD here/CMC-MATRIX-123610834.md`), 8/8 PASS, with 20 members
    // of `bstock-beacon-a` and 8 of `bstock-beacon-b` in the probed grant. Any
    // aggregator-era hire whose pinned bStocks all prove class membership live
    // matches this row without a probe of its own.
    profileId: "altana-c0f16888-bstock-class-v1",
    chainId: 56,
    accountCodeHash: "0x2f17b34a1c33b5fb9bd06422cec6782b367aa0e0bb09ee3c5263b14f4112a00f",
    tokenCodeHash: "0x97a48aa4c129657440dafdacd4c836389734d28cc4a0ca7403e68da660a74a59",
    permit2CodeHash: "0x48774d936722dd7002887f307f58bcddb3eeabad39149e7dcb5c08e4ebe3310f",
    settlerCodeHash: "0x0ba2481269cc11da9a6208fb34ea1c04cc05152551660b94465f65920b05bb71",
    checker: CMC_PERMIT2,
    grantShapeVersion: 2,
    grantShapeDigest: "0x4e9443dbf1cc5ff8f7fd933d479edd29d5b9930347dd6edb06a079699541e028",
    evidenceDigest: "0x93c35a8938978ae19b72740e90c2d60b6ab3b9633c380e56e6159cc528f5657d",
    matrix: {
      ownerApprovalPersists: true,
      unrelatedTradingPreservesAllowance: true,
      sessionApproveCannotIncreaseAllowance: true,
      noTemporaryApproveConsumePath: true,
      temporaryApproveCallbackReentryExcluded: true,
      revokeExpiryRejectsPayment: true,
      walletKeyExclusive: true,
      additiveIncreaseAllowance: true,
      proofDigests: [
        "0x253a3336b1f2c94ff0b7ab0301f99238bacd9811619c102ef1159bcb0a4ac574",
        "0xd79b4d2517e16ebbe9a9b5901eaa2fe877a2e0a8eb6de3f0864a85d660a3f19f",
        "0xd25642e439c5ccdc8f5de707e16cd5df170b1c9758a6cceee88bb081d2b09a9c",
        "0xb481b5676d9f12d7ea1e093ce6b46909cc5bab48e3dc41718a2152d8d2cf2f53",
        "0xbbc2f15cb32e0fdf8b18cb21e8fa780262aaef7411073c1bf3eb03d7d36c3200",
        "0x45006fd99ff29850302bc017328379c5832db81d5bfb7219e3a1f2ff6d73e735",
        "0x6a34d8e9b0e126e9ff2406578bd1f9d258bad6d658576dc7a14ee18d26b6e3b9",
        "0xdd4b179ccd2a08deb11e0e9397b67b4ee4059170fb906c37d2be71b0a1c60d16",
      ],
    },
  },
];
export function getCmcReviewedProfile(profileId: string): CmcReviewedProfile | null {
  return CMC_REVIEWED_PROFILES.find((profile) => profile.profileId === profileId) ?? null;
}

/**
 * The grant SHAPE a matrix was executed against: which functions the session
 * may call on which contracts, and which tokens carry a spend cap. Amounts and
 * expiry are deliberately excluded — they are per-hire, the shape is not.
 * Adding a selector or a capped token changes this digest and therefore
 * un-proves every profile until the matrix is re-run.
 */
export type CmcGrantShapeSpec = {
  readonly allowedCalls: readonly { readonly to?: string; readonly selector?: string }[];
  readonly spendCaps: readonly { readonly token?: string }[];
};

export function grantShapeDigestV1(spec: CmcGrantShapeSpec): Hex {
  const allowedCalls = spec.allowedCalls
    .map((rule) => ({
      ...(rule.to === undefined ? {} : { to: rule.to.toLowerCase() }),
      ...(rule.selector === undefined ? {} : { selector: rule.selector }),
    }))
    .map((rule) => ({ rule, key: canonicalEncode(rule) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry) => entry.rule);
  const capTokens = spec.spendCaps
    .map((cap) => (cap.token === undefined ? "native" : cap.token.toLowerCase()))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return keccak256(stringToBytes(canonicalEncode({ allowedCalls, capTokens, version: 1 })));
}

/**
 * Like `grantShapeDigestV1`, but a classed bStock's `approve` rule and its cap
 * token are each replaced with `CMC_TOKEN_CLASS_TAG` — the shape no longer
 * carries the pinned bStock's own address (CMC-TOKEN-CLASS-SPEC R1.2). A
 * classed address that carries any OTHER selector stays exact under its own
 * address, so a widened grant still changes the digest.
 */
export function grantShapeDigestV2(spec: CmcGrantShapeSpec, classed: ReadonlySet<string>): Hex {
  const encodedCalls = spec.allowedCalls.map((rule) => {
    const to = rule.to === undefined ? undefined : rule.to.toLowerCase();
    const classedTo = to !== undefined && rule.selector === CMC_APPROVE_SIGNATURE && classed.has(to) ? CMC_TOKEN_CLASS_TAG : to;
    return { ...(classedTo === undefined ? {} : { to: classedTo }), ...(rule.selector === undefined ? {} : { selector: rule.selector }) };
  });
  const allowedCalls = [...new Map(encodedCalls.map((rule) => [canonicalEncode(rule), rule])).values()]
    .map((rule) => ({ rule, key: canonicalEncode(rule) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry) => entry.rule);
  const encodedCaps = spec.spendCaps.map((cap) => {
    if (cap.token === undefined) return "native";
    const token = cap.token.toLowerCase();
    return classed.has(token) ? CMC_TOKEN_CLASS_TAG : token;
  });
  const capTokens = [...new Set(encodedCaps)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return keccak256(stringToBytes(canonicalEncode({ allowedCalls, capTokens, version: 2 })));
}

/** F5: a reviewed-profile miss, distinct from an RPC/read failure (CMC-TOKEN-CLASS-SPEC R1.4). */
export class CmcProfileUnavailableError extends Error {
  constructor() {
    super("cmc-profile-unavailable");
  }
}

export function cmcCapabilityEvidenceDigest(evidence: Pick<CmcCapabilityEvidence, "kind" | "source" | "chainId" | "accountCodeHash" | "tokenCodeHash" | "permit2CodeHash" | "settlerCodeHash" | "checker" | "grantShapeDigest"> & CmcMatrixFacts): Hex {
  return keccak256(stringToBytes(canonicalEncode({ kind: evidence.kind, source: evidence.source, chainId: evidence.chainId,
    accountCodeHash: evidence.accountCodeHash, tokenCodeHash: evidence.tokenCodeHash,
    permit2CodeHash: evidence.permit2CodeHash, settlerCodeHash: evidence.settlerCodeHash,
    checker: evidence.checker, grantShapeDigest: evidence.grantShapeDigest,
    matrix: { ownerApprovalPersists: evidence.ownerApprovalPersists, unrelatedTradingPreservesAllowance: evidence.unrelatedTradingPreservesAllowance,
      sessionApproveCannotIncreaseAllowance: evidence.sessionApproveCannotIncreaseAllowance, noTemporaryApproveConsumePath: evidence.noTemporaryApproveConsumePath,
      temporaryApproveCallbackReentryExcluded: evidence.temporaryApproveCallbackReentryExcluded, revokeExpiryRejectsPayment: evidence.revokeExpiryRejectsPayment,
      walletKeyExclusive: evidence.walletKeyExclusive, additiveIncreaseAllowance: evidence.additiveIncreaseAllowance, proofDigests: evidence.proofDigests } })));
}

export type CmcCapabilityVerdict =
  | { readonly available: true; readonly evidence: CmcCapabilityEvidence }
  | { readonly available: false; readonly reason: string };

export type CmcCapabilityReader = {
  read(input: {
    readonly agentId: string;
    readonly wallet: Address;
    readonly sessionPublicKey: Hex;
    readonly generation: number;
  }): Promise<CmcCapabilityEvidence | null>;
};

export type CmcCapabilityGate = {
  check(input: Parameters<CmcCapabilityReader["read"]>[0] & { readonly nowMs: number }): Promise<CmcCapabilityVerdict>;
};

function address(value: unknown): value is Address { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value); }
function hex32(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value); }

/** Validate a complete evidence matrix; a boolean/env flag cannot satisfy it. */
export function evaluateCmcCapability(input: {
  readonly evidence: CmcCapabilityEvidence | null;
  readonly profiles?: readonly CmcReviewedProfile[];
  readonly wallet: Address;
  readonly sessionPublicKey: Hex;
  readonly generation: number;
  readonly nowMs: number;
}): CmcCapabilityVerdict {
  const evidence = input.evidence;
  const profiles = input.profiles ?? CMC_REVIEWED_PROFILES;
  const evidenceDigest = evidence === null ? null : cmcCapabilityEvidenceDigest(evidence);
  const profile = evidence === null ? undefined : profiles.find((candidate) => candidate.profileId === evidence.profileId
    && candidate.chainId === evidence.chainId
    && candidate.accountCodeHash.toLowerCase() === evidence.accountCodeHash.toLowerCase()
    && candidate.tokenCodeHash.toLowerCase() === evidence.tokenCodeHash.toLowerCase()
    && candidate.permit2CodeHash.toLowerCase() === evidence.permit2CodeHash.toLowerCase()
    && candidate.settlerCodeHash.toLowerCase() === evidence.settlerCodeHash.toLowerCase()
    && candidate.checker.toLowerCase() === evidence.checker.toLowerCase()
    && candidate.grantShapeDigest.toLowerCase() === evidence.grantShapeDigest.toLowerCase()
    && JSON.stringify(candidate.matrix) === JSON.stringify({ ownerApprovalPersists: evidence.ownerApprovalPersists, unrelatedTradingPreservesAllowance: evidence.unrelatedTradingPreservesAllowance,
      sessionApproveCannotIncreaseAllowance: evidence.sessionApproveCannotIncreaseAllowance, noTemporaryApproveConsumePath: evidence.noTemporaryApproveConsumePath,
      temporaryApproveCallbackReentryExcluded: evidence.temporaryApproveCallbackReentryExcluded, revokeExpiryRejectsPayment: evidence.revokeExpiryRejectsPayment,
      walletKeyExclusive: evidence.walletKeyExclusive, additiveIncreaseAllowance: evidence.additiveIncreaseAllowance, proofDigests: evidence.proofDigests })
    && candidate.evidenceDigest.toLowerCase() === evidenceDigest?.toLowerCase());
  if (evidence === null || evidence.kind !== CMC_CAPABILITY_KIND || evidence.source !== "live-mainnet"
    || evidence.chainId !== 56 || !address(evidence.wallet) || evidence.wallet.toLowerCase() !== input.wallet.toLowerCase()
    || evidence.generation !== input.generation
    || evidence.sessionPublicKey.toLowerCase() !== input.sessionPublicKey.toLowerCase()
    || !hex32(evidence.accountCodeHash) || !hex32(evidence.tokenCodeHash) || !hex32(evidence.permit2CodeHash)
    || !hex32(evidence.settlerCodeHash) || !address(evidence.checker) || evidence.checker.toLowerCase() !== CMC_PERMIT2.toLowerCase()
    || evidence.finiteAllowanceWei < 0n || !hex32(evidence.grantShapeDigest)
    || evidence.ownerApprovalPersists !== true || evidence.unrelatedTradingPreservesAllowance !== true
    || evidence.sessionApproveCannotIncreaseAllowance !== true || evidence.noTemporaryApproveConsumePath !== true
    || evidence.temporaryApproveCallbackReentryExcluded !== true
    || evidence.revokeExpiryRejectsPayment !== true || evidence.walletKeyExclusive !== true
    || evidence.additiveIncreaseAllowance !== true || evidence.proofDigests.length < 1
    || evidence.proofDigests.some((digest) => !hex32(digest)) || evidence.observedAtMs > input.nowMs + CMC_EVIDENCE_FUTURE_SKEW_MS
    || profile === undefined
    || input.nowMs - evidence.observedAtMs > 15 * 60 * 1_000) {
    return { available: false, reason: "cmc-capability-matrix-unproven" };
  }
  return { available: true, evidence };
}

export function createCmcCapabilityGate(input: {
  readonly reader: CmcCapabilityReader;
  readonly profiles?: readonly CmcReviewedProfile[];
}): CmcCapabilityGate {
  return {
    async check(request) {
      try {
        return evaluateCmcCapability({ evidence: await input.reader.read(request), ...(input.profiles === undefined ? {} : { profiles: input.profiles }), wallet: request.wallet,
          sessionPublicKey: request.sessionPublicKey, generation: request.generation, nowMs: request.nowMs });
      } catch (error) {
        if (error instanceof CmcProfileUnavailableError) return { available: false, reason: "cmc-profile-unavailable" };
        return { available: false, reason: "cmc-capability-read-failed" };
      }
    },
  };
}

/** Persist the fresh verdict before an attempt can reserve budget. */
export async function refreshCmcCapability(input: {
  readonly gate: CmcCapabilityGate;
  readonly store: CmcBudgetStore;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly wallet: Address;
  readonly sessionPublicKey: Hex;
  readonly generation: number;
  readonly nowMs: number;
}): Promise<CmcCapabilityVerdict> {
  const verdict = await input.gate.check({ agentId: input.agentId, wallet: input.wallet,
    sessionPublicKey: input.sessionPublicKey, generation: input.generation, nowMs: input.nowMs });
  await input.store.setCapability({ agentId: input.agentId, ownerAddress: input.ownerAddress,
    generation: input.generation, available: verdict.available, reason: verdict.available ? null : verdict.reason, nowMs: input.nowMs });
  return verdict;
}
