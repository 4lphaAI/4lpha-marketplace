/**
 * PHASE4 — the calldata builders and the CLOSED selector census (R2.7, R2.1/2,
 * R2.15/R19d, R2.16/R29).
 *
 * Test obligation 3. Two properties matter more than the rest:
 *
 * 1. **The census is closed.** Every selector this phase can emit is
 *    enumerated here against the values recomputed from the deployed bytecode
 *    at block 117738703 (`.agents/HANDOFF.md`, 2026-08-24). A builder that
 *    starts emitting anything else fails this file — which is the point, since
 *    the grant pins selector+target and a new selector is a new authority.
 * 2. **The sentinel is forbidden.** `2^256-1` cannot be priced by the on-chain
 *    cap meter, and a max approve exhausts any finite per-token cap in one
 *    call — which, after R2.1, is the ONLY bound on a leaked-key drain.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, toFunctionSelector } from "viem";
import {
  UINT256_MAX,
  buildVenusClaimInterestCall,
  buildVenusClaimVenusCall,
  buildVenusRepayCalls,
  buildVenusSupplyCalls,
  buildVenusZeroApproveCall,
} from "../src/venus/builders.js";

const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
const COMPTROLLER = getAddress("0xfd36e2c2a6789db23113685031d7f16329158384");
const PRIME = getAddress("0x059eaba8676b03e4e8f009efb7f587c28450f50f");
const OWNER = getAddress("0x561b561ef37874c8e61534be9bae52eb6261ddc4");

/** The census, measured in deployed bytecode at block 117738703. */
const CENSUS = {
  "repayBorrow()": "0x4e4d9fea",
  "mint()": "0x1249c58b",
  "repayBorrow(uint256)": "0x0e752702",
  "mint(uint256)": "0xa0712d68",
  "approve(address,uint256)": "0x095ea7b3",
  "claimVenus(address,address[])": "0x86df31ee",
  "claimInterest(address,address)": "0xba437c68",
} as const;

/** Located in the same bytecode, and deliberately NOT granted. */
const REFUSED = {
  "borrow(uint256)": "0xc5ebeaec",
  "redeem(uint256)": "0xdb006a75",
  "redeemUnderlying(uint256)": "0x852a12e3",
  "enterMarkets(address[])": "0xc2998238",
  "exitMarket(address)": "0xede4edd0",
} as const;

const selectorOf = (call: { readonly data?: `0x${string}` }): string =>
  (call.data ?? "0x").slice(0, 10);

function allSelectors(): Set<string> {
  const calls = [
    ...buildVenusRepayCalls({
      vToken: V_BNB,
      underlying: null,
      amountWei: 10n ** 15n,
      currentAllowanceWei: 0n,
    }),
    ...buildVenusRepayCalls({
      vToken: V_USDT,
      underlying: USDT,
      amountWei: 10n ** 18n,
      currentAllowanceWei: 5n,
    }),
    // REVISION 4: a native supply is UNREPRESENTABLE — `underlying` is a
    // non-null Address on the supply builder, so the census harness cannot
    // even construct the call that minted the (as-2) one-way position.
    ...buildVenusSupplyCalls({
      vToken: V_USDT,
      underlying: USDT,
      amountWei: 10n ** 18n,
      currentAllowanceWei: 0n,
    }),
    ...buildVenusClaimVenusCall(COMPTROLLER, OWNER, [V_USDT]),
    ...buildVenusClaimInterestCall(PRIME, V_USDT, OWNER),
    ...buildVenusZeroApproveCall(USDT, V_USDT),
  ];
  const seen = new Set<string>();
  for (const call of calls) {
    const selector = selectorOf(call);
    if (selector !== "0x") seen.add(selector);
  }
  return seen;
}

describe("venus builders: the census is CLOSED", () => {
  it("every census entry equals the selector recomputed from its signature", () => {
    // Independent of the recorded bytes: recompute from the signature text.
    // If these ever disagree, one of the two is a typo and the grant is wrong.
    for (const [signature, selector] of Object.entries(CENSUS)) {
      assert.equal(
        toFunctionSelector(signature),
        selector,
        `${signature} does not hash to ${selector}`,
      );
    }
    for (const [signature, selector] of Object.entries(REFUSED)) {
      assert.equal(toFunctionSelector(signature), selector);
    }
  });

  it("the builders emit ONLY census selectors — no member may be added silently", () => {
    const emitted = allSelectors();
    const allowed = new Set<string>(Object.values(CENSUS));
    for (const selector of emitted) {
      assert.ok(
        allowed.has(selector),
        `The builders emitted ${selector}, which is not in the closed census. A new ` +
          "selector is a new authority: extend the census, the session template and " +
          "the audit together, or do not emit it.",
      );
    }
  });

  it("the builders emit NONE of the refused selectors", () => {
    const emitted = allSelectors();
    for (const [signature, selector] of Object.entries(REFUSED)) {
      assert.ok(
        !emitted.has(selector),
        `The builders emitted ${signature} (${selector}), which the grant refuses.`,
      );
    }
  });

  it("the emitted set is exactly the write shapes plus approve — and mint() is GONE", () => {
    // REVISION 4: the payable `mint()` 0x1249c58b left the EMITTED set when
    // the native supply became unrepresentable. It stays in the CENSUS table
    // above as a measured selector (the sig->hex pinning is about bytecode
    // facts, not about what we emit), and its ABSENCE here is the assertion:
    // no builder can produce the call that minted the (as-2) one-way position.
    const emitted = allSelectors();
    assert.ok(!emitted.has("0x1249c58b"), "a builder emitted the native mint()");
    assert.deepEqual(
      [...emitted].sort(),
      [
        "0x095ea7b3", // approve(address,uint256)
        "0x0e752702", // repayBorrow(uint256)
        "0x4e4d9fea", // repayBorrow()  — native REPAY stays (measured safe, V8)
        "0x86df31ee", // claimVenus(address,address[])
        "0xa0712d68", // mint(uint256)  — ERC-20 supply stays
        "0xba437c68", // claimInterest(address,address)
      ].sort(),
    );
  });
});

describe("venus builders: the native branch", () => {
  it("a native repay attaches msg.value and calls the NO-ARG selector", () => {
    const calls = buildVenusRepayCalls({
      vToken: V_BNB,
      underlying: null,
      amountWei: 3_000_000_000_000_000n,
      currentAllowanceWei: 0n,
    });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.to, V_BNB);
    assert.equal(call.value, 3_000_000_000_000_000n);
    assert.equal(selectorOf(call), CENSUS["repayBorrow()"]);
  });

  it("REVISION 4 — a native SUPPLY is unrepresentable at the type level", () => {
    // FINDINGS (at): vBNB's mint() built a position an EIP-7702 wallet cannot
    // redeem, and the guard walked into it live. The closure is a TYPE, not a
    // runtime check: `VenusSupplyCallInput.underlying` is a non-null Address,
    // so the following does not compile —
    //
    //   buildVenusSupplyCalls({ vToken: V_BNB, underlying: null, ... })
    //     // @ts-expect-error would fire here if anyone re-widened the type
    //
    // and what a type forbids, a test can only DOCUMENT. The runtime halves
    // (refusal-first in supplyFilter/sizeVenusSupply, the worker's
    // requireErc20Underlying tripwire) are pinned in venus.sizing.test.ts and
    // venus.worker.test.ts.
    const widened = buildVenusSupplyCalls as unknown as (input: {
      vToken: typeof V_BNB;
      underlying: null;
      amountWei: bigint;
      currentAllowanceWei: bigint;
    }) => unknown;
    // Driven through the widened signature, the builder must FAIL loudly
    // rather than quietly emit the payable mint it used to.
    assert.throws(() =>
      widened({
        vToken: V_BNB,
        underlying: null,
        amountWei: 10n ** 15n,
        currentAllowanceWei: 0n,
      }),
    );
  });

  it("R2.16/R29 — the native branch has no sentinel to forbid, the amount IS msg.value", () => {
    // The prohibition is ERC-20-only in its MEANING, but the guard is on the
    // amount, so it still refuses an absurd native value rather than trying to
    // attach it.
    assert.throws(
      () =>
        buildVenusRepayCalls({
          vToken: V_BNB,
          underlying: null,
          amountWei: UINT256_MAX,
          currentAllowanceWei: 0n,
        }),
      /sentinel is FORBIDDEN/u,
    );
  });
});

describe("venus builders: the ERC-20 branch and the allowance", () => {
  it("emits approve(exact) then repayBorrow(amount) — never a max approve", () => {
    const amount = 8_001_452_073_265_578_256n;
    const calls = buildVenusRepayCalls({
      vToken: V_USDT,
      underlying: USDT,
      amountWei: amount,
      currentAllowanceWei: 0n,
    });
    assert.equal(calls.length, 2);
    const [approve, repay] = calls;
    assert.ok(approve !== undefined && repay !== undefined);
    assert.equal(approve.to, USDT);
    assert.equal(selectorOf(approve), CENSUS["approve(address,uint256)"]);
    // The amount is encoded verbatim in the approve's last word.
    assert.ok(approve.data !== undefined);
    assert.equal(BigInt(`0x${approve.data.slice(-64)}`), amount);
    assert.equal(repay.to, V_USDT);
    assert.equal(selectorOf(repay), CENSUS["repayBorrow(uint256)"]);
    // No value is attached on the ERC-20 path.
    assert.equal(approve.value, undefined);
    assert.equal(repay.value, undefined);
  });

  it("R2.1/R25 — a RESIDUAL allowance is zeroed FIRST, in the same submission", () => {
    const calls = buildVenusRepayCalls({
      vToken: V_USDT,
      underlying: USDT,
      amountWei: 10n ** 18n,
      currentAllowanceWei: 7n,
    });
    assert.equal(calls.length, 3);
    const [zero, approve, repay] = calls;
    assert.ok(zero !== undefined && approve !== undefined && repay !== undefined);
    assert.equal(selectorOf(zero), CENSUS["approve(address,uint256)"]);
    assert.equal(BigInt(`0x${(zero.data as string).slice(-64)}`), 0n);
    assert.equal(BigInt(`0x${(approve.data as string).slice(-64)}`), 10n ** 18n);
    assert.equal(selectorOf(repay), CENSUS["repayBorrow(uint256)"]);
  });

  it("no residual means no zero leg — two calls, not three", () => {
    const calls = buildVenusRepayCalls({
      vToken: V_USDT,
      underlying: USDT,
      amountWei: 10n ** 18n,
      currentAllowanceWei: 0n,
    });
    assert.equal(calls.length, 2);
  });

  it("the sentinel and zero are both refused on the token path", () => {
    for (const amountWei of [UINT256_MAX, 0n, -1n]) {
      assert.throws(() =>
        buildVenusSupplyCalls({
          vToken: V_USDT,
          underlying: USDT,
          amountWei,
          currentAllowanceWei: 0n,
        }),
      );
    }
  });

  it("the standalone zero-approve sweep encodes spender and zero, nothing else", () => {
    const calls = buildVenusZeroApproveCall(USDT, V_USDT);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.to, USDT);
    assert.equal(selectorOf(call), CENSUS["approve(address,uint256)"]);
    assert.equal(BigInt(`0x${(call.data as string).slice(-64)}`), 0n);
  });
});

describe("venus builders: the claim legs and their honest residual", () => {
  it("claimVenus names the holder as an ARGUMENT — the true R19d sentence", () => {
    const calls = buildVenusClaimVenusCall(COMPTROLLER, OWNER, [V_USDT, V_BNB]);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.to, COMPTROLLER);
    assert.equal(selectorOf(call), CENSUS["claimVenus(address,address[])"]);
    // The holder is encoded in the first word: it is calldata, not a target
    // bound. A leaked key can aim this at a third party; what it cannot do is
    // move the OWNER's rewards away from the owner, because payment follows the
    // named holder's own accrual.
    assert.ok((call.data as string).toLowerCase().includes(OWNER.slice(2).toLowerCase()));
  });

  it("an empty market list is refused rather than submitted as a no-op", () => {
    assert.throws(
      () => buildVenusClaimVenusCall(COMPTROLLER, OWNER, []),
      /must not be empty/u,
    );
  });

  it("claimInterest targets Prime, with (vToken, user) in that order", () => {
    const calls = buildVenusClaimInterestCall(PRIME, V_USDT, OWNER);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.to, PRIME);
    assert.equal(selectorOf(call), CENSUS["claimInterest(address,address)"]);
    const data = (call.data as string).toLowerCase();
    const first = data.slice(10, 74);
    const second = data.slice(74, 138);
    assert.ok(first.endsWith(V_USDT.slice(2).toLowerCase()));
    assert.ok(second.endsWith(OWNER.slice(2).toLowerCase()));
  });
});
