import type { RailwayRole } from "./cleanExec.js";

export type RailwayBundleRole = Readonly<{
  role: RailwayRole;
  output: string;
  payload: string;
  sourceEntry: string;
  argv: readonly string[];
}>;

export const RAILWAY_BUNDLE_ROLES: readonly RailwayBundleRole[] = Object.freeze([
  Object.freeze({
    role: "api",
    output: "api.mjs",
    payload: "api.payload.mjs",
    sourceEntry: "src/index-server.ts",
    argv: Object.freeze(["/usr/local/bin/node", "/app/dist/railway/api.mjs"]),
  }),
  Object.freeze({
    role: "lp-worker",
    output: "lp-worker.mjs",
    payload: "lp-worker.payload.mjs",
    sourceEntry: "scripts/lp-worker.ts",
    argv: Object.freeze(["/usr/local/bin/node", "/app/dist/railway/lp-worker.mjs"]),
  }),
  Object.freeze({
    role: "venus-worker",
    output: "venus-worker.mjs",
    payload: "venus-worker.payload.mjs",
    sourceEntry: "scripts/venus-worker.ts",
    argv: Object.freeze(["/usr/local/bin/node", "/app/dist/railway/venus-worker.mjs"]),
  }),
  Object.freeze({
    role: "billing-worker-once",
    output: "billing-worker.mjs",
    payload: "billing-worker.payload.mjs",
    sourceEntry: "scripts/billing-worker.ts",
    argv: Object.freeze([
      "/usr/local/bin/node",
      "/app/dist/railway/billing-worker.mjs",
      "--once",
    ]),
  }),
]);
