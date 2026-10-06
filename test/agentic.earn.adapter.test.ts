/** AGENTIC-EARN-SPEC ET4: every parser of earnAdapter.ts on an E0-shaped fixture (a guess until the E0 probe, patch P2 to P5) and on mutated ones (missing field, string where number, percent versus fraction, an unknown interact-with) -> null or refusal;
 *  the rule 22 answer table, the argv builders and the pinned constants. */
import assert from "node:assert/strict";
import test from "node:test";
import { EARN_PRODUCTS, EARN_SERVER_REFUSALS, EARN_USDT, earnApyBps, earnCliName, earnConfigured, earnDepositArgs, earnListArgs, earnPreviewArgs, earnQty, earnRedeemArgs, earnResponse, earnSelfRescueCommand,
  parseEarnList, parseEarnPreview, parseEarnTx, type EarnProduct } from "../src/agentic/earnAdapter.js";
import { E, NULL_PRODUCTS, PRODUCTS, TARGETS, tx } from "./support/agenticEarn.js";
import type { BawResult } from "../src/agentic/baw.js";

const VENUS_ID = "5b77bfd8d8f7c18e9ee0d8f331c4d78f56744eed8addbe2e9970c0ef37e763cb", AAVE_ID = "9e901e308ea48144dcce3d77f22be8fbc0dbeef09167174a5a5dbb3b05c6a5e8";
const USDT_ADDR = "0x55d398326f99059ff775485246999027b3197955";
/** A list row in the shape E0 measured (2026-10-06): 11 keys, no `investable`, `apy` null, the base rate as integer `apyBps`. */
const real = (id: string, protocol: string, protocolName: string, apyBps: unknown, extra: Record<string, unknown> = {}) => ({ binanceChainId: "56", defiProtocolId: protocol, protocolName, investmentId: id, investmentName: "USDT",
  investType: "Earn", apyType: "APY", apy: null, tvl: "177993991.42", apyBps, apyDisplay: typeof apyBps === "number" ? `${apyBps / 100}%` : null, ...extra });
const list = (...rows: unknown[]) => ({ total: rows.length, list: rows });
/** The eight USDT Earn rows E0 returned (ids of the other protocols shortened: they never match a configured product). */
const E0_LIST = list(real("dca20c822a4a", "nestcredit", "Plume", 1097), real("dfeb150e0001", "helio", "Helio", 625), real("375fd8860002", "helio", "Helio", 531), real(VENUS_ID, "venus", "Venus", 345),
  real("fd3134fd0003", "helio", "Helio", 336), real("f7ebeb9f0004", "venusflux", "Venus Flux", 336), real(AAVE_ID, "aave3", "Aave V3", 306), real("3b92702a0005", "helio", "Helio", 237));

test("A1 the shipped constants carry the E0 ids and preview targets, both pinned by contract; a null-id table stays fail-closed", () => {
  assert.deepEqual(EARN_PRODUCTS.map(p => [p.protocol, p.receiptToken, p.investmentId, p.previewTargets]), [["venus", "0xfd5840cd36d94d7229439859c0112a4185bc0255", VENUS_ID, ["0xfd5840cd36d94d7229439859c0112a4185bc0255"]],
    ["aave-v3", "0xa9251ca9de909cb71783723713b21e4233fbf1b1", AAVE_ID, ["0x6807dc923806fe8fd134338eabca509979a7e0cb"]]]);
  assert.equal(EARN_PRODUCTS[1]!.pool, "0x6807dc923806fe8fd134338eabca509979a7e0cb");
  assert.deepEqual(EARN_PRODUCTS.map(earnConfigured), [true, true]);
  assert.deepEqual(PRODUCTS.map(earnConfigured), [true, true]);
  // fail closed: without an id or a preview target a product is never a candidate and has no self-rescue command
  assert.deepEqual(NULL_PRODUCTS.map(earnConfigured), [false, false]);
  assert.deepEqual(NULL_PRODUCTS.map(p => [p.investmentId, p.previewTargets]), [[null, null], [null, null]]);
  assert.deepEqual(parseEarnList(E0_LIST, NULL_PRODUCTS), [], "an unconfigured product is never a candidate");
  assert.deepEqual(parseEarnList(E0_LIST, [{ ...EARN_PRODUCTS[0]!, previewTargets: [] }, { ...EARN_PRODUCTS[1]!, previewTargets: null }]), [], "a missing preview target is as unconfigured as a missing id");
  assert.equal(earnSelfRescueCommand(NULL_PRODUCTS[0]!), null);
  assert.equal(earnSelfRescueCommand(EARN_PRODUCTS[0]!), `baw defi redeem --investmentId ${VENUS_ID} --tokenAddress 0x55d398326f99059fF775485246999027B3197955 --ratio 1`);
});

test("A2 the APY is the row's integer apyBps in 0 to 5 000; a string, a fraction, a negative, a float, null or more than 50 % is null", () => {
  assert.deepEqual([345, 306, 0, 1, 5000].map(earnApyBps), [345, 306, 0, 1, 5000]);
  for (const bad of [5001, -1, 3.45, 0.0345, "345", "3.45%", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}]) assert.equal(earnApyBps(bad), null, String(bad));
});

test("A3 parseEarnList on the real E0 list: Venus 345 and Aave 306 by Binance's own protocol ids; a mutated row is dropped; other protocols' higher rates never match", () => {
  assert.deepEqual(parseEarnList(E0_LIST, EARN_PRODUCTS), [{ protocol: "venus", apyBps: 345 }, { protocol: "aave-v3", apyBps: 306 }]);
  assert.deepEqual(parseEarnList(list(real(AAVE_ID, "aave3", "Aave V3", 306)), EARN_PRODUCTS), [{ protocol: "aave-v3", apyBps: 306 }], "Aave is listed under aave3");
  const mutated: unknown[] = [real(VENUS_ID, "venus", "Venus", "345"), real(VENUS_ID, "venus", "Venus", 3.45), real(VENUS_ID, "venus", "Venus", null), real(VENUS_ID, "venus", "Venus", 345, { apyBps: undefined, apyDisplay: "3.45%" }),
    real(VENUS_ID, "aave3", "Venus", 345), real(VENUS_ID, "aave-v3", "Venus", 345), real(AAVE_ID, "aave-v3", "Aave V3", 306), real("0".repeat(64), "venus", "Venus", 345),
    real(VENUS_ID, "venus", "Venus", 345, { investable: false }), { defiProtocolId: "venus", apyBps: 345 }, null, "row", real(AAVE_ID, "aave3", "Aave V3", 9_999)];
  assert.deepEqual(parseEarnList(list(...mutated), EARN_PRODUCTS), []);
  assert.deepEqual(parseEarnList(list(real(VENUS_ID, "venus", "Venus", 345), real(VENUS_ID, "venus", "Venus", 400)), EARN_PRODUCTS), [{ protocol: "venus", apyBps: 345 }], "one listing per product");
  assert.deepEqual(parseEarnList(list(real(VENUS_ID, "venus", "Venus", 345, { investable: true })), EARN_PRODUCTS), [{ protocol: "venus", apyBps: 345 }], "an explicit true is fine");
  for (const bad of [null, [], "x", { list: "x" }, { rows: [] }, 3]) assert.equal(parseEarnList(bad, EARN_PRODUCTS), null);
});

test("A3b E0 fixtures: the investment-info and preview answers as measured (feeRate and poolAddress null, investable true, balanceChange, interactWith)", () => {
  const info = { binanceChainId: "56", defiProtocolId: "aave3", protocolName: "Aave V3", investmentId: AAVE_ID, investmentName: "USDT", investType: "Earn", investable: true, apy: null, apyType: "APY", tvl: "65544710.94",
    poolAddress: null, feeRate: null, assetTokenList: [{ tokenAddress: USDT_ADDR, tokenName: "Tether USDT", tokenSymbol: "USDT" }], rewardTokenList: [{ tokenAddress: USDT_ADDR, tokenName: "Tether USDT", tokenSymbol: "USDT" }],
    lpTokenList: [], borrowTokenList: [], apyBps: 306, apyDisplay: "3.06%" };
  assert.deepEqual([info.investable, info.feeRate, info.poolAddress, earnApyBps(info.apyBps)], [true, null, null, 306]);
  assert.ok(info.rewardTokenList.every(token => token.tokenAddress === USDT_ADDR), "the reward list is USDT only: the rate is a base rate");
  const preview = (symbol: string, token: string, minted: string, address: string, fee: string) => ({ balanceChange: [{ tokenSymbol: "USDT", tokenAddress: USDT_ADDR, amount: "-1", valueUsd: "0.999745107379538" }, { tokenSymbol: symbol, tokenAddress: token, amount: minted, valueUsd: "0.9997" }],
    feeAndContract: { estimatedNetworkFee: { amount: fee, tokenSymbol: "BNB", valueUsd: "0.011188" }, interactWith: { address } }, warnings: [] });
  const venus = preview("vUSDT", "0xfd5840cd36d94d7229439859c0112a4185bc0255", "37.67826142", "0xfd5840cd36d94d7229439859c0112a4185bc0255", "0.00002063613716286");
  const aave = preview("aBnbUSDT", "0xa9251ca9de909cb71783723713b21e4233fbf1b1", "0.999999999999999998", "0x6807dc923806fe8fd134338eabca509979a7e0cb", "0.00001438300382202");
  for (const [answer, product] of [[venus, EARN_PRODUCTS[0]!], [aave, EARN_PRODUCTS[1]!]] as const) {
    const parsed = parseEarnPreview(answer);
    assert.ok(parsed?.interactWith !== null && product.previewTargets!.includes(parsed!.interactWith!), product.protocol);
  }
  assert.equal(EARN_PRODUCTS[0]!.previewTargets!.includes(parseEarnPreview(aave)!.interactWith!), false, "Aave's Pool is not a Venus target");
  assert.equal(EARN_PRODUCTS[1]!.previewTargets!.includes(parseEarnPreview(venus)!.interactWith!), false, "vUSDT is not an Aave target");
});

test("A4 parseEarnPreview reads only the interact-with address; the lane compares it with the product's pinned targets", () => {
  assert.deepEqual(parseEarnPreview({ feeAndContract: { interactWith: { address: "0x5555555555555555555555555555555555555555" } } }), { interactWith: TARGETS.venus });
  assert.deepEqual(parseEarnPreview({ feeAndContract: { interactWith: { address: "0x55555555555555555555555555555555555555" } } }), { interactWith: null }, "short");
  assert.deepEqual(parseEarnPreview({ feeAndContract: {} }), { interactWith: null });
  assert.deepEqual(parseEarnPreview({}), { interactWith: null });
  for (const bad of [null, [], "x", 5]) assert.equal(parseEarnPreview(bad), null);
});

test("A5 parseEarnTx: a 64-hex txHash and an absent, null or empty redeemDelayDays; a non-empty one is delayed; anything else is null", () => {
  assert.deepEqual(parseEarnTx({ txHash: tx(1) }), { txHash: tx(1), delayed: false });
  assert.deepEqual(parseEarnTx({ txHash: tx(1).toUpperCase().replace("0X", "0x"), redeemDelayDays: null }), { txHash: tx(1), delayed: false });
  assert.deepEqual(parseEarnTx({ txHash: tx(1), redeemDelayDays: [] }), { txHash: tx(1), delayed: false });
  assert.deepEqual(parseEarnTx({ txHash: tx(1), redeemDelayDays: [7] }), { txHash: tx(1), delayed: true });
  for (const bad of [{}, { txHash: "0x12" }, { txHash: 5 }, { txHash: tx(1), redeemDelayDays: 7 }, { txHash: tx(1), redeemDelayDays: "7" }, null, []]) assert.equal(parseEarnTx(bad), null);
});

test("A6 rule 22: ok with a hash is accepted; a delayed redeem is accepted with a hold; a client-side name rolls back; every other answer is held", () => {
  const ok = (data: unknown): BawResult => ({ kind: "ok", data, sessionPresent: true, rwaTokens: null });
  const err = (name: string): BawResult => ({ kind: "cli-error", code: 351763, name, orderId: null, sessionPresent: true });
  assert.deepEqual(earnResponse("deposit", ok({ txHash: tx(1) })), { response: "accepted", txHash: tx(1), holdReason: null, note: "accepted", rollBack: false });
  assert.equal(earnResponse("redeem", ok({ txHash: tx(1), redeemDelayDays: [3] })).holdReason, "redeem-delayed");
  assert.equal(earnResponse("deposit", ok({ txHash: tx(1), redeemDelayDays: [3] })).holdReason, null, "only a redeem is delayed");
  for (const name of ["INVALID_PARAMS", "INVALID_AMOUNT", "INVALID_ADDRESS"]) assert.deepEqual([earnResponse("deposit", err(name)).response, earnResponse("deposit", err(name)).rollBack], ["rejected", true], name);
  for (const name of ["INSUFFICIENT_BALANCE", "DEFI_TX_SIMULATION_FAILED", "SERVICE_ERROR", "SESSION_EXPIRED", "REQUEST_TIMEOUT", "INVESTMENT_NOT_INVESTABLE"]) {
    const answer = earnResponse("deposit", err(name));
    assert.deepEqual([answer.response, answer.holdReason, answer.rollBack, answer.note], ["no-response", "no-response", false, `cli-error:351763:${name}`], name);
  }
  for (const result of [ok({}), ok({ txHash: "0x1" }), { kind: "no-response", code: "timeout", sessionPresent: true }, { kind: "no-response", code: "unparseable", sessionPresent: true }] as BawResult[]) {
    const answer = earnResponse("redeem", result);
    assert.deepEqual([answer.response, answer.holdReason, answer.rollBack, answer.txHash], ["no-response", "no-response", false, null]);
  }
  assert.equal(earnCliName("cli-error:351763:DEFI_TX_SIMULATION_FAILED"), "DEFI_TX_SIMULATION_FAILED");
  for (const bad of [null, "timeout", "cli-error:x:NAME", "cli-error:1:lower"]) assert.equal(earnCliName(bad), null, String(bad));
});

test("A7 the argv builders pass only USDT and a configured product, with the CLI's own option names; amounts are human decimals and ratio 1 is the word", () => {
  const venus: EarnProduct = PRODUCTS[0]!;
  assert.deepEqual(earnListArgs(), ["defi", "investment-list", "--investType", "Earn", "--contractAddresses", EARN_USDT, "--binanceChainId", "56", "--sortField", "apy", "--sortDirection", "DESC", "--page", "1", "--size", "100"]);
  assert.deepEqual(earnListArgs("aave-v3").slice(0, 6), ["defi", "investment-list", "--investType", "Earn", "--defiProtocolId", "aave3"], "Binance id, not our label");
  assert.deepEqual(earnListArgs("venus").slice(4, 6), ["--defiProtocolId", "venus"]);
  assert.deepEqual(earnDepositArgs(venus, 20_010_000_000_000_000_000n), ["defi", "deposit", "--investmentId", "venus-usdt", "--tokenAddress", EARN_USDT, "--amount", "20.01", "--binanceChainId", "56"]);
  assert.deepEqual(earnRedeemArgs(venus, { amountWei: 5n * E, ratio: false }), ["defi", "redeem", "--investmentId", "venus-usdt", "--tokenAddress", EARN_USDT, "--amount", "5", "--binanceChainId", "56"]);
  assert.deepEqual(earnRedeemArgs(venus, { amountWei: 5n * E, ratio: true }), ["defi", "redeem", "--investmentId", "venus-usdt", "--tokenAddress", EARN_USDT, "--ratio", "1", "--binanceChainId", "56"]);
  assert.deepEqual(earnPreviewArgs("redeem", venus, { amountWei: E, ratio: true }), ["defi", "preview", "--action", "redeem", "--investmentId", "venus-usdt", "--tokenAddress", EARN_USDT, "--ratio", "1", "--binanceChainId", "56"]);
  assert.deepEqual([earnQty({ amountWei: 3n * E, ratio: false }), earnQty({ amountWei: 3n * E, ratio: true })], ["3", "ratio:1"]);
  const all = [earnListArgs(), earnDepositArgs(venus, E), earnRedeemArgs(venus, { amountWei: E, ratio: true })].flat();
  for (const forbidden of ["claim", "lp-add", "lp-remove", "protocol-list", "protocol-info", "BNB", "vBNB", "Loan"]) assert.ok(!all.includes(forbidden), forbidden);
});

test("A8 E0: Binance's real DeFi codes are 6000xxxx, not 35176x; the plane keys on the NAME only (rule 26a), so the measured refusals are the same classes as the spec's", () => {
  const err = (code: number, name: string): BawResult => ({ kind: "cli-error", code, name, orderId: null, sessionPresent: true });
  for (const [code, name] of [[60_002_001, "DEFI_TX_SIMULATION_FAILED"], [60_003_001, "INVESTMENT_NO_POSITION"]] as const) {
    const answer = earnResponse("redeem", err(code, name));
    assert.deepEqual([answer.response, answer.holdReason, answer.rollBack, answer.note], ["no-response", "no-response", false, `cli-error:${code}:${name}`], name);
    assert.equal(earnCliName(answer.note), name);
    assert.ok(EARN_SERVER_REFUSALS.has(name), name + " is one of the eight rule 26a names");
  }
});
