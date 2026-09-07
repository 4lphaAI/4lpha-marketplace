import { registerHooks } from "node:module";

// Revision 7 permits this one literal, test-owned substitution so the normal
// production CLI can exercise its full structural path without vendoring the
// official base layers or reviewed helper binary. No caller input selects any
// trust value here, and static tests prove this module cannot enter a release.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/deployment/railwayConstants.ts") ||
        url.endsWith("/src/deployment/railwayConstants.js")) {
      return {
        format: "module",
        shortCircuit: true,
        source: [
          'export const RAILWAY_NODE_VERSION = "22.23.2";',
          'export const RAILWAY_PLATFORM = "linux/amd64";',
          'export const RAILWAY_BASE_MANIFEST_DIGEST = "sha256:b5c57f37ad1c27f879ff8a0430532ded0eb0fe451d69fcf743f902f425d646ae";',
          "export const AWS_SIGNING_HELPER = Object.freeze({",
          '  version: "1.8.4",',
          '  path: "/usr/local/bin/aws_signing_helper",',
          '  url: "test-only://synthetic-helper",',
          "  bytes: 26,",
          '  sha256: "733f620a7292ac98a7207538531ad8bd50e078fdbceea24fdbd0f293bae7e045",',
          "});",
          'export const RAILWAY_LAUNCHER_PATH = "/usr/local/bin/railway-launcher";',
          "export const RAILWAY_UID = 10_001;",
          "export const RAILWAY_GID = 10_001;",
        ].join("\n"),
      };
    }
    return nextLoad(url, context);
  },
});
