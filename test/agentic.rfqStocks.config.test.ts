/** AGENTIC-RFQ-STOCKS 4.1 (E1): AGENTIC_RFQ_STOCKS_ENABLED parses like AGENTIC_DCA_ENABLED and refuses boot without the wallet flag. */
import assert from "node:assert/strict";
import test from "node:test";
import { agenticRfqEnabled, resolveAgenticConfig } from "../src/agentic/config.js";

const input = { hireEnabled: true, tradeAgentEnabled: true, rpcUrls: ["a", "b", "c"] };
const env = { AGENTIC_WALLET_ENABLED: "true", DATABASE_URL: "postgres://x", EXECUTION_MASTER_KEY: "k", AGENTIC_BAW_CLI: process.platform === "win32" ? "C:\\\\baw.cjs" : "/baw.cjs" };

test("flag values: exactly true enables, empty or false or absent is off, anything else refuses", () => {
  assert.deepEqual([undefined, "", "false", "true"].map((value) => agenticRfqEnabled(value === undefined ? {} : { AGENTIC_RFQ_STOCKS_ENABLED: value })), [false, false, false, true]);
  for (const bad of ["TRUE", "1", "yes", "True", " true", "False", "on"]) assert.throws(() => agenticRfqEnabled({ AGENTIC_RFQ_STOCKS_ENABLED: bad }), /AGENTIC_RFQ_STOCKS_ENABLED/u, bad);
});

test("true needs the wallet flag; the default config is off and carries rfq false", () => {
  assert.throws(() => resolveAgenticConfig({ AGENTIC_RFQ_STOCKS_ENABLED: "true" }, input), /requires AGENTIC_WALLET_ENABLED/u);
  assert.deepEqual(resolveAgenticConfig({ AGENTIC_RFQ_STOCKS_ENABLED: "false" }, input), { enabled: false });
  assert.throws(() => resolveAgenticConfig({ ...env, AGENTIC_RFQ_STOCKS_ENABLED: "TRUE" }, input), /AGENTIC_RFQ_STOCKS_ENABLED/u);
});

test("boot line: the rfq token appears only when on, so the line of a flag-off process is the one the DCA suite pins", (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const on = resolveAgenticConfig({ ...env, AGENTIC_RFQ_STOCKS_ENABLED: "true" }, input);
  const off = resolveAgenticConfig(env, input);
  const both = resolveAgenticConfig({ ...env, AGENTIC_RFQ_STOCKS_ENABLED: "true", AGENTIC_DCA_ENABLED: "true" }, input);
  assert.deepEqual([on.enabled && on.rfq, off.enabled && off.rfq, both.enabled && both.rfq && both.dca], [true, false, true]);
  assert.deepEqual(logs, ["agentic-flags wallet=true dca=false rfq=true", "agentic-flags wallet=true dca=false", "agentic-flags wallet=true dca=true rfq=true"]);
});
