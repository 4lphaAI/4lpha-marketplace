/** AGENTIC-EARN-SPEC ET1: AGENTIC_EARN_ENABLED exactly true enables, empty or false is off, anything else refuses boot, true needs the wallet flag; the boot line gains ` earn=true` only when on (FL1 pins the off line). */
import assert from "node:assert/strict";
import test from "node:test";
import { agenticEarnEnabled, resolveAgenticConfig } from "../src/agentic/config.js";

const boot = { hireEnabled: true, tradeAgentEnabled: true, rpcUrls: ["a", "b", "c"] };
const env = { AGENTIC_WALLET_ENABLED: "true", DATABASE_URL: "postgres://x", EXECUTION_MASTER_KEY: "k", AGENTIC_BAW_CLI: process.platform === "win32" ? "C:\\\\baw.cjs" : "/baw.cjs" };

test("C1 flag values: exactly true enables, unset, empty and false are off, anything else refuses", () => {
  assert.deepEqual([undefined, "", "false", "true"].map(v => agenticEarnEnabled(v === undefined ? {} : { AGENTIC_EARN_ENABLED: v })), [false, false, false, true]);
  for (const bad of ["TRUE", "1", "yes", "True", " true", "on"]) assert.throws(() => agenticEarnEnabled({ AGENTIC_EARN_ENABLED: bad }), /AGENTIC_EARN_ENABLED/u, bad);
  assert.throws(() => resolveAgenticConfig({ ...env, AGENTIC_EARN_ENABLED: "maybe" }, boot), /AGENTIC_EARN_ENABLED/u);
});

test("C2 earn needs the wallet flag; with the wallet flag off the config is just disabled", () => {
  assert.throws(() => resolveAgenticConfig({ AGENTIC_EARN_ENABLED: "true" }, boot), /requires AGENTIC_WALLET_ENABLED/u);
  assert.deepEqual(resolveAgenticConfig({ AGENTIC_EARN_ENABLED: "false" }, boot), { enabled: false });
});

test("C3 the boot line appends earn=true last and only when on; an off line stays byte-identical", t => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const on = resolveAgenticConfig({ ...env, AGENTIC_EARN_ENABLED: "true" }, boot), off = resolveAgenticConfig(env, boot);
  const all = resolveAgenticConfig({ ...env, AGENTIC_DCA_ENABLED: "true", AGENTIC_RFQ_STOCKS_ENABLED: "true", AGENTIC_MEME_STOCKS_ENABLED: "true", AGENTIC_EARN_ENABLED: "true" }, boot);
  assert.deepEqual([on.enabled && on.earn, off.enabled && off.earn, all.enabled && all.earn], [true, false, true]);
  assert.deepEqual(logs, ["agentic-flags wallet=true dca=false earn=true", "agentic-flags wallet=true dca=false", "agentic-flags wallet=true dca=true rfq=true meme=true earn=true"]);
});
