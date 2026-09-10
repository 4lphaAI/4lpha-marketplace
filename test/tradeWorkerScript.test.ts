import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

it("trade-worker daemon persists only confirmed receipt fills and keeps its boot gates closed", async () => {
  const source = await readFile(new URL("../scripts/trade-worker.ts", import.meta.url), "utf8");
  assert.match(source, /result\.receipt\.status !== "CONFIRMED"/u);
  // AUDIT H2, NARROWED (AGENT-GAS-ATTENTION, review finding: this pin refused
  // the gas reader's wiring). The invariant is that a FILL is never derived
  // from a balance bracket — confirmed fills come from the transaction receipt.
  // It was written as "the string `provider.getBalance` must not appear", which
  // is broader than the rule and refused a read that has nothing to do with
  // fills: the wallet's NATIVE balance, used only to decide whether the relay
  // can be paid at all.
  //
  // So the pin now says what it means: `provider.getBalance` may appear ONLY as
  // the gas reader's binding. Any other use — including one smuggled onto a
  // fill path — still fails, and the two positive assertions below stop the
  // exemption from being widened into "the gate is not wired at all".
  // REVIEW 2 — the exemption is ONE EXACT LINE, not "any line mentioning
  // walletNativeBalance". The first narrowing let a substring buy the pass:
  // adding `// walletNativeBalance:` as a COMMENT to a second, balance-derived
  // fill line satisfied it, which is the hole the pin exists to close.
  const BINDING = `    walletNativeBalance: (wallet) => provider.getBalance({ address: wallet }),`;
  const balanceLines = source.split(/\r?\n/u).filter((line) => /provider\.getBalance/u.test(line));
  assert.equal(
    balanceLines.length,
    1,
    `provider.getBalance may appear exactly once (the gas reader); found ${balanceLines.length}`,
  );
  assert.equal(
    balanceLines[0]?.replace(/\r$/u, ""),
    BINDING,
    "the single provider.getBalance line must be the gas reader binding verbatim",
  );
  assert.match(source, /gasBackoff: createTradeGasBackoff\(\)/u);
  assert.match(source, /raw === "" \|\| raw === "false"/u);
  assert.match(source, /raw === "true"/u);
  assert.match(source, /must be exactly "true" or "false"/u);
  assert.match(source, /OPENROUTER_API_KEY/u);
  assert.match(source, /resolveLpRpcUrls\(process\.env, readerNetwork\)/u);
  assert.match(source, /createRouteQuoteReader\(\{ rpcUrls \}\)/u);
  assert.match(source, /await routeReader\.getChainId\(\) !== 56/u);
  assert.match(source, /Math\.min\(600, Math\.max\(60,/u);
  assert.doesNotMatch(source, /OWNER_PRIVATE_KEY|SESSION_PRIVATE_KEY/u);
});
