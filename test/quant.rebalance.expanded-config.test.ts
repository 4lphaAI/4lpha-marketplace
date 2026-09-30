import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { parseConfigBlock } from "../src/quant/termix.js";
import {
  expandedConfigVenueTargets, findExpandedConfigProfile, normalizeExpandedQuantConfig,
  type QuantExpandedConfigProfile,
} from "../src/quant/rebalanceConfig.js";

const SOURCE_CAPTURE_SHA256 = "BF3D32B15B06BDE032713A49B4583B9DB4C810F9C32787CED7644458C9F7EB46";
const FIXTURE_SHA256 = `0x${"7A925003313951FC0480E5A4F6CCD11A9F37D709838D7D23C2D455AE9D76880F".toLowerCase()}` as const;

function captured(): Record<string, unknown> {
  const bytes = readFileSync(new URL("./fixtures/quant/contracts-customization-quant.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex").toUpperCase(), FIXTURE_SHA256.slice(2).toUpperCase());
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

describe("expanded TermiX config alias evidence", () => {
  it("preserves all 14 raw rows, matches their exact multiset, then derives 12 unique targets", () => {
    const parsed = parseConfigBlock(captured());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.data.tradableTokens.length, 7);
    assert.equal(parsed.data.venueRows?.length, 14);
    assert.deepEqual(parsed.data.venueAllowlist, []);
    const normalized = normalizeExpandedQuantConfig(parsed.data);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const profile: QuantExpandedConfigProfile = {
      id: "offline-captured-config",
      capturedEvidenceRef: `quant subset; source contracts.customization SHA256 ${SOURCE_CAPTURE_SHA256}`,
      capturedEvidenceDigest: FIXTURE_SHA256,
      expected: normalized.projection,
      expectedVenueRowCount: 14,
      expectedUniqueVenueTargetCount: 12,
    };
    assert.equal(findExpandedConfigProfile(normalized.projection, [profile])?.id, profile.id);
    const targets = expandedConfigVenueTargets(normalized.projection, profile);
    assert.equal(targets?.length, 12);
    assert.equal(targets?.filter((address) => address === getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d").toLowerCase()).length, 1);
    assert.equal(targets?.filter((address) => address === getAddress("0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c").toLowerCase()).length, 1);
    assert(normalized.projection.venueRows.some((row) => row.label === "USDC token"));
    assert(normalized.projection.venueRows.some((row) => row.label === "vUSDC"));
    assert(normalized.projection.venueRows.some((row) => row.label === "BTCB"));
    assert(normalized.projection.venueRows.some((row) => row.label === "vBTC"));

    const reordered = normalizeExpandedQuantConfig({ ...parsed.data, venueRows: [...parsed.data.venueRows!].reverse() });
    assert.equal(reordered.ok, true);
    if (reordered.ok) assert.equal(findExpandedConfigProfile(reordered.projection, [profile])?.id, profile.id);
  });

  it("refuses metadata, multiplicity, missing-field, and unknown-field mutations before target derivation", () => {
    const parsed = parseConfigBlock(captured());
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.data.venueRows === undefined) return;
    const normalized = normalizeExpandedQuantConfig(parsed.data);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    const profile: QuantExpandedConfigProfile = { id: "offline-captured-config",
      capturedEvidenceRef: `quant subset; source contracts.customization SHA256 ${SOURCE_CAPTURE_SHA256}`,
      capturedEvidenceDigest: FIXTURE_SHA256, expected: normalized.projection,
      expectedVenueRowCount: 14, expectedUniqueVenueTargetCount: 12 };

    const extraDuplicate = normalizeExpandedQuantConfig({ ...parsed.data,
      venueRows: [...parsed.data.venueRows, parsed.data.venueRows.find((row) => row.label === "vUSDC")!] });
    assert.equal(extraDuplicate.ok, true);
    if (extraDuplicate.ok) {
      assert.equal(findExpandedConfigProfile(extraDuplicate.projection, [profile]), null);
      assert.equal(expandedConfigVenueTargets(extraDuplicate.projection, profile), null);
    }
    const changedUrl = normalizeExpandedQuantConfig({ ...parsed.data, venueRows: parsed.data.venueRows.map((row) =>
      row.label === "vUSDC" ? { ...row, officialUrl: "https://changed.invalid" } : row) });
    assert.equal(changedUrl.ok, true);
    if (changedUrl.ok) assert.equal(findExpandedConfigProfile(changedUrl.projection, [profile]), null);

    const raw = captured(); const quant = raw["quant"] as Record<string, unknown>;
    const venues = quant["venueAllowlist"] as Array<Record<string, unknown>>;
    const missing = { ...raw, quant: { ...quant, venueAllowlist: venues.map((row, index) => index === 0
      ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== "protocol")) : row) } };
    assert.equal(parseConfigBlock(missing).ok, false);
    const unknown = { ...raw, quant: { ...quant, venueAllowlist: venues.map((row, index) => index === 0
      ? { ...row, unexpected: "ignored must not happen" } : row) } };
    assert.equal(parseConfigBlock(unknown).ok, false);
    const wrongType = { ...raw, quant: { ...quant, venueAllowlist: venues.map((row, index) => index === 0
      ? { ...row, verified: "true" } : row) } };
    assert.equal(parseConfigBlock(wrongType).ok, false);
  });
});
