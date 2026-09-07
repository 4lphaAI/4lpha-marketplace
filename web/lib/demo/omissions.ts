/**
 * DEMO MODE — what the grid model leaves out, for surfaces that have no
 * projection to read it from.
 *
 * The plane sends this list on every agent projection (`disclosure.omits`), and
 * a screen that HAS a projection must render THAT one — it is the authority,
 * and a screen showing a stale copy of a disclosure would be its own small
 * dishonesty.
 *
 * This copy exists for exactly one surface: the deploy screen's success panel,
 * which appears the instant a demo is created, BEFORE the panel below it has
 * polled anything — and which would otherwise show a bare success with no
 * caveats if that first poll failed (fix-review finding 16).
 *
 * It is kept byte-identical to `DEMO_GRID_OMISSIONS` in `src/demo/config.ts`.
 * `web/` never imports from `../src/`, so the duplication is the trust
 * boundary's price; the two are short, and the plane's copy wins wherever both
 * are available.
 */
export const DEMO_GRID_OMISSIONS: readonly string[] = [
  "fees earned while the price sits inside a range",
  "the price impact this position's own liquidity would have",
  "partial fills, MEV and failed submissions",
  "the value of inventory a level is holding between fills, when the price moves one way and stays",
];
