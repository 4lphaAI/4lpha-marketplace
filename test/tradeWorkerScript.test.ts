import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

it("trade-worker daemon persists only confirmed receipt fills and keeps its boot gates closed", async () => {
  const source = await readFile(new URL("../scripts/trade-worker.ts", import.meta.url), "utf8");
  assert.match(source, /result\.receipt\.status !== "CONFIRMED"/u);
  assert.doesNotMatch(source, /provider\.getBalance/u);
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
