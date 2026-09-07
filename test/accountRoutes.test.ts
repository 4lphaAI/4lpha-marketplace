import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import {
  CHAIN_ID,
  NETWORK,
  call,
  createHarness,
  signOwnerAction,
  toReadHeader,
} from "./support/serverHarness.js";

const WBNB = getAddress("0x3333333333333333333333333333333333333333");
const KEY_ID: Hex = `0x${"22".repeat(32)}`;
/** 64 flat bytes that derive SOMEBODY, and not this harness's owner. */
const OTHER_PUBLIC_KEY: Hex = `0x${"11".repeat(64)}`;

describe("account portfolio routes", () => {
  it("exchanges one consumed signature for an account-only bearer", async () => {
    const harness = await createHarness({ config: {
      accountReadSession: {
        key: parseAccountReadSessionSecret("cd".repeat(32))!,
        chainId: CHAIN_ID,
        environment: resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK }),
      },
      accountPortfolioWbnb: WBNB,
    } });
    const envelope = await signOwnerAction("createAccountReadSession", {}, { agentId: "*" });
    const issued = await call(harness, "/owner-read-session", { method: "POST", body: envelope });
    assert.equal(issued.status, 200);
    const token = (issued.body["data"] as { token: string }).token;

    const portfolio = await call(harness, "/account/portfolio", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(portfolio.status, 200);
    assert.match(portfolio.text, /"ownerAddress"/u);
    assert.doesNotMatch(portfolio.text.toLowerCase(), /agent-2/u);
    assert.equal(harness.provider.executeCalls.length, 0);

    const replay = await call(harness, "/owner-read-session", { method: "POST", body: envelope });
    assert.equal(replay.status, 401);
    const ambiguous = await call(harness, "/account/portfolio", {
      headers: { authorization: `Bearer ${token}`, "x-owner-action": "not-used" },
    });
    assert.equal(ambiguous.status, 401);
    const wrongRoute = await call(harness, "/agents", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(wrongRoute.status, 401);
  });

  it("rejects non-empty issuance params before consuming the nonce", async () => {
    const harness = await createHarness({ config: {
      accountReadSession: { key: parseAccountReadSessionSecret("cd".repeat(32))!, chainId: CHAIN_ID, environment: resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK }) },
      accountPortfolioWbnb: WBNB,
    } });
    const valid = await signOwnerAction("createAccountReadSession", {}, { agentId: "*" });
    const malformed = { ...valid, params: { extra: true } };
    assert.equal((await call(harness, "/owner-read-session", { method: "POST", body: malformed })).status, 401);
    assert.equal((await call(harness, "/owner-read-session", { method: "POST", body: valid })).status, 200);
    assert.equal((await call(harness, "/account/portfolio")).status, 401);
  });

  it("reads a caller-declared wallet the plane owns no rows for", async () => {
    const harness = await createHarness({ config: { accountPortfolioWbnb: WBNB } });
    const declared = getAddress(`0xfab7${"0".repeat(32)}bee9`);
    harness.provider.getBalance = async () => 10n ** 17n;
    const envelope = await signOwnerAction("read", {}, { agentId: "*" });
    const portfolio = await call(harness, `/account/portfolio?wallets=${declared}`, {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(portfolio.status, 200);
    const wallets = (portfolio.body["data"] as { wallets: readonly Record<string, unknown>[] }).wallets;
    const entry = wallets.find((wallet) => wallet["address"] === declared.toLowerCase());
    assert.notEqual(entry, undefined);
    assert.equal(entry!["source"], "declared");
    assert.equal(entry!["custodyModel"], "passkey");
    assert.equal(entry!["depositable"], true);
    assert.equal(entry!["deployedUsdMicros"], "0");
    assert.equal(entry!["deployedReason"], "declared");
    assert.equal(wallets.filter((wallet) => wallet["source"] === "declared").length, 1);
    const assets = (portfolio.body["data"] as { assets: readonly Record<string, unknown>[] }).assets;
    const native = assets.find((asset) => asset["kind"] === "native" && asset["walletAddress"] === declared.toLowerCase());
    assert.equal(native?.["balanceAtomic"], "100000000000000000");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("refuses a declared wallet the KeyStore registers to a different owner", async () => {
    const harness = await createHarness({ config: { accountPortfolioWbnb: WBNB }, keyStoreReader: {
      listKeys: async () => [KEY_ID],
      publicKeyFor: async () => OTHER_PUBLIC_KEY,
    } });
    const declared = getAddress("0xfab7ae2f15124a05b2939365b0e51533a122bee9");
    const response = await call(harness, `/account/portfolio?wallets=${declared}`, {
      headers: { "x-owner-action": toReadHeader(await signOwnerAction("read", {}, { agentId: "*" })) },
    });
    assert.equal(response.status, 400);
    assert.equal((response.body["error"] as { code: string }).code, "invalid_request");
    assert.equal(harness.provider.executeCalls.length, 0);
  });

  it("returns the entry with its verdict for every non-refusing KeyStore answer", async () => {
    const declared = getAddress("0xfab7ae2f15124a05b2939365b0e51533a122bee9");
    for (const [reader, expected] of [
      // `not-registered` is the NORMAL state of a funded, unused passkey
      // wallet, so it must still return balances rather than refuse.
      [{ listKeys: async () => [], publicKeyFor: async () => OTHER_PUBLIC_KEY }, "not-registered"],
      [{ listKeys: async () => { throw new Error("rpc down"); }, publicKeyFor: async () => OTHER_PUBLIC_KEY }, "unreadable"],
      [undefined, "unreadable"],
    ] as const) {
      const harness = await createHarness({ config: { accountPortfolioWbnb: WBNB }, ...(reader === undefined ? {} : { keyStoreReader: reader }) });
      harness.provider.getBalance = async () => 10n ** 17n;
      const response = await call(harness, `/account/portfolio?wallets=${declared}`, {
        headers: { "x-owner-action": toReadHeader(await signOwnerAction("read", {}, { agentId: "*" })) },
      });
      assert.equal(response.status, 200);
      const wallets = (response.body["data"] as { wallets: readonly Record<string, unknown>[] }).wallets;
      const entry = wallets.find((wallet) => wallet["address"] === declared.toLowerCase());
      assert.equal(entry?.["passkeyVerified"], expected);
      assert.equal(entry?.["source"], "declared");
    }
  });

  it("refuses more than two declared wallets and anything that is not an address", async () => {
    const harness = await createHarness({ config: { accountPortfolioWbnb: WBNB } });
    const a = getAddress("0x1111111111111111111111111111111111111111");
    const b = getAddress("0x2222222222222222222222222222222222222222");
    const c = getAddress("0x4444444444444444444444444444444444444444");
    const header = async () => toReadHeader(await signOwnerAction("read", {}, { agentId: "*" }));
    for (const query of [`${a},${b},${c}`, "not-an-address", `${a},0x1234`, ""]) {
      const response = await call(harness, `/account/portfolio?wallets=${query}`, {
        headers: { "x-owner-action": await header() },
      });
      assert.equal(response.status, 400);
      assert.equal((response.body["error"] as { code: string }).code, "invalid_request");
    }
    const ok = await call(harness, `/account/portfolio?wallets=${a},${b}`, {
      headers: { "x-owner-action": await header() },
    });
    assert.equal(ok.status, 200);
  });

  it("keeps signed reads available while session issuance is capability-hidden", async () => {
    const harness = await createHarness({ config: { accountPortfolioWbnb: WBNB } });
    const envelope = await signOwnerAction("read", {}, { agentId: "*" });
    const portfolio = await call(harness, "/account/portfolio", {
      headers: { "x-owner-action": toReadHeader(envelope) },
    });
    assert.equal(portfolio.status, 200);
    assert.equal((await call(harness, "/owner-read-session", { method: "POST", body: {} })).status, 404);
    assert.equal(harness.provider.executeCalls.length, 0);
  });
});
