/**
 * M4 (review): the Permit2 signing domain was only needed by the NodeOps wallet-mode hosting payment. Hosting is
 * now Railway (env vars, no payment), so studio.toml carries no Permit2 entry and no witness-transfer type. As a
 * second layer, no code path reachable from a buyer or from the model can ask for such a signature; these tests
 * pin both by reading the config and the source.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string): string => readFileSync(root + rel, "utf8");
const deskFiles = readdirSync(root + "src/desk").filter((f) => f.endsWith(".ts")).map((f) => `src/desk/${f}`);

describe("no buyer-reachable path can request a Permit2 signature", () => {
  const reachable = [...deskFiles, "src/tools.ts", "src/x402Buyer.ts", "src/agentCard.ts", "src/executor.ts", "src/sellerCore.ts"];
  it("no reachable source names Permit2, the witness type, or a raw signing call", () => {
    for (const f of reachable) {
      const t = read(f);
      assert.ok(!/Permit2|PermitWitnessTransferFrom|0x000000000022D473030F116dDEE9F6B43aC78BA3/i.test(t), `${f} mentions Permit2`);
      assert.ok(!/signTypedData|signMessage|sendTransaction|writeContract|privateKey/i.test(t), `${f} signs or sends directly`);
    }
  });
  it("the wallet is imported only by the buyer (and the scaffold's signing, model and entrypoint files), never by the desk pipeline", () => {
    for (const f of deskFiles) assert.ok(!/studio-runtime\/wallet/.test(read(f)), `${f} imports the wallet`);
    assert.ok(/studio-runtime\/wallet/.test(read("src/x402Buyer.ts")));
  });
  it("the only payment call is the buyer, with a hardcoded URL, called from the backdrop leg only", () => {
    const users = [...deskFiles, "src/tools.ts", "src/executor.ts", "src/sellerCore.ts", "src/unifiedMain.ts"].filter((f) => /buyWithX402|x402Buyer/.test(read(f)));
    assert.deepEqual(users, ["src/desk/backdrop.ts"]);
    assert.match(read("src/desk/backdrop.ts"), /export const BACKDROP_URL = "https:\/\/pro-api\.coinmarketcap\.com\//);
  });
  it("the model is called without tools everywhere", () => {
    const calls = deskFiles.filter((f) => /generateText\(/.test(read(f)));
    assert.deepEqual(calls, ["src/desk/prose.ts"]);
    const body = read("src/desk/prose.ts");
    const call = body.slice(body.indexOf("generateText({"), body.indexOf("});", body.indexOf("generateText({")));
    assert.ok(!/tools/.test(call), "generateText is given tools");
    assert.ok(!/tools\.js/.test(read("src/unifiedMain.ts")), "the entrypoint no longer wires the chain tools into the model");
  });
});

describe("studio.toml bounds", () => {
  const toml = read("studio.toml");
  it("no Permit2 domain, no witness-transfer type and no NodeOps hosting payment remain (review M4 closed)", () => {
    assert.ok(!/Permit2|PermitWitnessTransferFrom|0x000000000022D473030F116dDEE9F6B43aC78BA3/i.test(toml.replace(/^#.*$/gm, "")));
    assert.ok(!/extra_primary_types/.test(toml));
    assert.ok(!toml.includes("[deploy.nodeops"));
    assert.ok(!/max_per_payment_usd|max_approval_gas_wei|auto_pay/.test(toml));
  });
  it("only the two EIP-3009 token domains the CoinMarketCap buyer signs are allowed", () => {
    const m = /extra_domains\s*=\s*(\[\[.*\]\])/.exec(toml);
    assert.ok(m);
    assert.deepEqual(JSON.parse((m as RegExpExecArray)[1] as string), [[56, "0xcE24439F2D9C6a2289F741120FE202248B666666"], [56, "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d"]]);
  });
  it("the data purchase caps and the public wallet address are in place", () => {
    assert.ok(toml.includes("per_call_cap_usd = 0.02"));
    assert.ok(toml.includes("max_per_request_usd = 0.05"));
    assert.ok(toml.includes("max_per_day_usd = 1.0"));
    assert.ok(toml.includes('address = "0x592EF127feFd45eAA56fE0D715dAAF72F998A652"'));
    assert.ok(!/\[budget\][^[]*enabled\s*=\s*true/.test(toml), "the Pieverse auto top-up gate stays off");
  });
});
