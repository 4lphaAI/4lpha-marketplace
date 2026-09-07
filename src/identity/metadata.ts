import { fail, REGISTRY, validCategory, validId, validRef, type IdentityCategory, type MetadataVersion } from "./types.js";

const LABELS = { grid: "Grid", trading: "Trading", lp: "LP", lending: "Health Guard" } as const;
const DESCRIPTIONS = {
  grid: "A 4lpha grid trading deployment. Its ERC-8004 identity is owned and managed by the platform minter; trading funds retain their separate wallet custody.",
  trading: "A 4lpha trading deployment. Its ERC-8004 identity is owned and managed by the platform minter; trading funds retain their separate wallet custody.",
  lp: "A 4lpha liquidity provision deployment. Its ERC-8004 identity is owned and managed by the platform minter; trading funds retain their separate wallet custody.",
  lending: "A 4lpha lending health guard. Its ERC-8004 identity is owned and managed by the platform minter; the rescue reserve retains its separate wallet custody.",
} as const;
const V2_DESCRIPTIONS = {
  grid: "Automated grid market making that buys low and sells high as market prices move using PancakeSwap V3 on BNB Chain.",
  trading: "Screens eligible markets, sizes entries, and automatically manages buys and exits using Four.Meme, Flap.sh, and PancakeSwap V3 on BNB Chain.",
  lp: "Routes liquidity to the best APR or fee opportunities with auto-rebalancing, compounding, and risk exits using PancakeSwap V3 on BNB Chain.",
  lending: "Watches a Venus Core borrow position and repays its debt from a reserve when the health factor falls, on BNB Chain.",
} as const;
/**
 * The public marketplace origin, and the ONE place a host is written on-chain.
 *
 * A registration whose `services[]` names no protocol adapter is read as a
 * dormant wallet entry by every registry consumer (`web` and `X` match no
 * adapter), so the MCP face is what makes an identity callable. Moving the
 * marketplace to another domain therefore costs one `setAgentURI` per live
 * identity — deliberate: the endpoint must be true at the block it is read.
 */
const ORIGIN = "https://4lpha.tech";

/**
 * FROZEN. v1 and v2 emitted exactly this, and `validateLedger` re-derives every
 * stored job's URIs from these builders and compares them BYTE FOR BYTE on each
 * ledger read. Editing this list retroactively invalidates every job that was
 * minted from it and takes the whole identity machine down with an
 * `intent_mismatch` loop — which is how v3 came to exist. Add services in a NEW
 * version; never here.
 */
const LEGACY_SERVICES = [
  { name: "web", endpoint: "https://4lpha.tech" },
  { name: "X", endpoint: "https://x.com/4lpha_agent" },
] as const;

/** v3 = the legacy set plus the callable MCP face, which leads. */
const SERVICES_V3 = [
  { name: "MCP", endpoint: `${ORIGIN}/mcp` },
  ...LEGACY_SERVICES,
] as const;

const copy = (services: readonly { readonly name: string; readonly endpoint: string }[]) => services.map((service) => ({ ...service }));
export function metadataTemplate(category: IdentityCategory) {
  if (!validCategory(category)) fail("invalid_identity");
  return { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: `4lpha ${LABELS[category]}`, description: DESCRIPTIONS[category],
    image: "https://4lpha.tech/4lpha_logo_180.png", services: copy(LEGACY_SERVICES),
    website: "https://4lpha.tech", socials: { x: "https://x.com/4lpha_agent" }, x402Support: false };
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]));
  return value;
}
export function metadataUri(category: IdentityCategory, publicRef: string, agentId: string | null = null): string {
  if (!validCategory(category) || !validRef(publicRef) || agentId !== null && !validId(agentId)) fail("invalid_identity");
  const template = metadataTemplate(category);
  const value = { ...template, name: `${template.name} ${publicRef.slice(0, 8)}`, registrations: agentId === null ? [] : [{ agentId, agentRegistry: `eip155:56:${REGISTRY}` }],
    x4lpha: { instanceRef: publicRef, category, identityCustody: "platform-minter" } };
  const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(sorted(value)), "utf8").toString("base64")}`;
  if (Buffer.byteLength(uri) > 16 * 1024) fail("invalid_identity");
  return uri;
}

/**
 * v2 and v3 differ ONLY in `services`. One body, so the two can never drift in
 * key order or in any other field — which matters because `validateLedger`
 * re-derives both and compares bytes.
 */
function numberedUri(services: readonly { readonly name: string; readonly endpoint: string }[], category: IdentityCategory, displayNumber: number, publicRef: string, agentId: string | null, image: string): string {
  if (!validCategory(category) || !Number.isSafeInteger(displayNumber) || displayNumber < 1 || !validRef(publicRef) || agentId !== null && !validId(agentId)) fail("invalid_identity");
  const label = category === "lp" ? "LP" : category[0]!.toUpperCase() + category.slice(1);
  const value = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: `${label} Agent ${displayNumber} by 4LPHA`, description: V2_DESCRIPTIONS[category], image,
    services: copy(services), website: "https://4lpha.tech", socials: { x: "https://x.com/4lpha_agent" }, x402Support: false,
    registrations: agentId === null ? [] : [{ agentId, agentRegistry: `eip155:56:${REGISTRY}` }], x4lpha: { instanceRef: publicRef, category, displayNumber, identityCustody: "platform-minter" } };
  const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(sorted(value)), "utf8").toString("base64")}`;
  if (Buffer.byteLength(uri) > 16 * 1024) fail("invalid_identity");
  return uri;
}

export function metadataUriV2(category: IdentityCategory, displayNumber: number, publicRef: string, agentId: string | null = null, image = "https://4lpha.tech/4lpha_logo_180.png"): string {
  return numberedUri(LEGACY_SERVICES, category, displayNumber, publicRef, agentId, image);
}

export function metadataUriV3(category: IdentityCategory, displayNumber: number, publicRef: string, agentId: string | null = null, image = "https://4lpha.tech/4lpha_logo_180.png"): string {
  return numberedUri(SERVICES_V3, category, displayNumber, publicRef, agentId, image);
}

/** The metadata version a NEW job is stamped with. */
export const CURRENT_METADATA_VERSION = 3 as const;

/**
 * The ONE resolver every caller uses. Three call sites used to repeat
 * `(v ?? 1) === 2 ? V2 : V1`; a third version in three parallel ternaries is
 * how they drift, and drift here brings the identity machine down.
 */
export function metadataUriFor(version: MetadataVersion | undefined, category: IdentityCategory, displayNumber: number | undefined, publicRef: string, agentId: string | null = null): string {
  const resolved = version ?? 1;
  if (resolved === 1) return metadataUri(category, publicRef, agentId);
  if (displayNumber === undefined) fail("invalid_identity");
  return resolved === 2
    ? metadataUriV2(category, displayNumber, publicRef, agentId)
    : metadataUriV3(category, displayNumber, publicRef, agentId);
}
