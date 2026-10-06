/** AGENTIC-MEME-STOCKS-SPEC 9.5: AGENTIC_MEME_STOCKS_ENABLED parses like the RFQ flag, requires the wallet flag, and prints its boot token only when on. */
import assert from "node:assert/strict";
import test from "node:test";
import { agenticMemeEnabled, resolveAgenticConfig } from "../src/agentic/config.js";

const input = { hireEnabled: true, tradeAgentEnabled: true, rpcUrls: ["a", "b", "c"] };
const env = { AGENTIC_WALLET_ENABLED: "true", DATABASE_URL: "postgres://x", EXECUTION_MASTER_KEY: "k", AGENTIC_BAW_CLI: process.platform === "win32" ? "C:\\\\baw.cjs" : "/baw.cjs" };

test("flag values: exactly true enables, empty or false or absent is off, anything else refuses", () => {
  assert.deepEqual([undefined, "", "false", "true"].map((value) => agenticMemeEnabled(value === undefined ? {} : { AGENTIC_MEME_STOCKS_ENABLED: value })), [false, false, false, true]);
  for (const bad of ["TRUE", "1", "yes", " true", "on"]) assert.throws(() => agenticMemeEnabled({ AGENTIC_MEME_STOCKS_ENABLED: bad }), /AGENTIC_MEME_STOCKS_ENABLED/u, bad);
});

test("true needs the wallet flag; an invalid value refuses boot", () => {
  assert.throws(() => resolveAgenticConfig({ AGENTIC_MEME_STOCKS_ENABLED: "true" }, input), /requires AGENTIC_WALLET_ENABLED/u);
  assert.deepEqual(resolveAgenticConfig({ AGENTIC_MEME_STOCKS_ENABLED: "false" }, input), { enabled: false });
  assert.throws(() => resolveAgenticConfig({ ...env, AGENTIC_MEME_STOCKS_ENABLED: "maybe" }, input), /AGENTIC_MEME_STOCKS_ENABLED/u);
});

test("boot line: ' meme=true' after ' rfq=true' only when on; the flag-off line is the one the DCA suite pins", (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const on = resolveAgenticConfig({ ...env, AGENTIC_MEME_STOCKS_ENABLED: "true" }, input);
  const off = resolveAgenticConfig(env, input);
  resolveAgenticConfig({ ...env, AGENTIC_MEME_STOCKS_ENABLED: "true", AGENTIC_RFQ_STOCKS_ENABLED: "true" }, input);
  assert.deepEqual([on.enabled && on.meme, off.enabled && off.meme], [true, false]);
  assert.deepEqual(logs, ["agentic-flags wallet=true dca=false meme=true", "agentic-flags wallet=true dca=false", "agentic-flags wallet=true dca=false rfq=true meme=true"]);
});
