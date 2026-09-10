# Design QA — Marketplace search

source visual truth path: `C:/Users/Pro/AppData/Local/Temp/codex-clipboard-d7c057d3-c588-4b56-8b25-2e6b5f9cbeec.png`
implementation screenshot path: `http://localhost:3000/` (Codex in-app Browser capture; focused search clip captured inline)
viewport: available Codex in-app Browser viewport, 311 px wide
source and implementation dimensions: source 355 × 52 px; implementation focused clip 311 × 56 px, CSS density 1; no density normalization
state: marketplace loaded, search empty; focused interaction states also checked for `sigma` and a no-match query

## Comparison evidence

- Full-view: the existing dark marketplace header uses the same compact search treatment as the supplied reference: left search icon, muted placeholder, dark input surface and thin rounded border.
- Focused region: source input is 320 × 40 px inside the 355 × 52 px crop; implementation input is 295 × 40 px at the narrow viewport and preserves the same height, radius, icon placement, contrast and typography. Width is intentionally fluid on mobile.
- No generated or replacement image asset was needed. The existing design-system search icon is reused.

## Findings

No actionable P0/P1/P2 mismatch found.

## Interaction checks

- Typing `sigma` leaves only `Sigma Trader`.
- Typing a non-existent value shows `No agents match these filters`.
- Clearing the input restores all 9 agents.
- Search remains available in the narrow responsive header.
- Browser console check found no application errors; only the existing Lit development-mode warning.

## Implementation Checklist

- [x] Controlled search input in the shared header.
- [x] Case-insensitive filtering by agent name, tagline, protocol, pair and category.
- [x] Empty state copy covers search and filters.
- [x] Responsive search visibility verified.
- [x] Typecheck, tests and production build pass.

final result: passed

---

# Design QA — Deploy settings UI import (2026-09-08)

source visual truth path: `C:/Users/Pro/AppData/Local/Temp/codex-clipboard-d6ca07f7-6d43-489d-b464-8c58cdcd3395.png`
implementation screenshot path: unavailable; the current local/public `/deploy/grid` route stays on the marketplace shell after the existing client interaction, so a faithful browser capture of the deploy screen could not be obtained without changing routing outside this request.
viewport: source 1114 × 997 px; implementation screenshot not captured
state: deploy settings form, Demo/Live control unchanged

## Evidence and checks

- Static render verification covered `grid`, `trading`, `lp`, and `health` screens.
- Each screen renders the scoped deploy styling, protocol chip, Guides, Tutorial Videos, and Reset parameters controls.
- The existing Demo/Live values and deploy components remain wired unchanged.
- No image asset was invented; existing PancakeSwap, BNB Chain, and Venus protocol assets are reused.

## Findings

- [P1] Browser comparison blocked by the pre-existing `/deploy/*` client route not transitioning from the marketplace shell. No route or hydration change was made because the request is UI-only and explicitly excludes unrelated app behavior.

## Implementation Checklist

- [x] Shared Claude Design form treatment applied to Grid, Trading, LP, and Lending.
- [x] Protocol chip added for each deploy kind.
- [x] Demo/Live semantics, defaults, API calls, and deploy handlers preserved.
- [x] Web typecheck passes.
- [x] Static render checks pass for all four deploy kinds.
- [ ] Browser screenshot comparison after the existing route-transition blocker is resolved.

final result: blocked
