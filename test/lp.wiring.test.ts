/**
 * LP boot wiring (PHASE3 build item 3): the tri-state master switch, the
 * boot-throws-on-malformed address resolution, and the 404 posture a server
 * without LP deps keeps — byte-identical to an unknown path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, zeroAddress } from "viem";
import { resolveLpEnabled } from "../src/ops/config.js";
import {
  PANCAKE_V3_FACTORY_56,
  PANCAKE_V3_QUOTER_V2_56,
  resolveLpAddresses,
} from "../src/lp/readers.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import {
  AGENT_ID,
  EXEC_TOKEN,
  call,
  createHarness,
  errorCode,
} from "./support/serverHarness.js";

const KEY_STORE = getAddress("0x00000000000000000000000000000000000000ff");
const ROUTER_V3 = getAddress("0x7777777777777777777777777777777777777777");
const WBNB = getAddress("0x2222222222222222222222222222222222222222");

describe("resolveLpEnabled — the tri-state master switch", () => {
  it("defaults OFF, honours exactly 'true'/'false', and a typo fails the boot", () => {
    assert.equal(resolveLpEnabled({}), false);
    assert.equal(resolveLpEnabled({ LP_ENABLED: "" }), false);
    assert.equal(resolveLpEnabled({ LP_ENABLED: "true" }), true);
    assert.equal(resolveLpEnabled({ LP_ENABLED: "false" }), false);
    // An operator who wrote any of these believed they enabled LP; a server
    // that silently 404s while looking healthy is the F8 shape with money.
    for (const typo of ["TRUE", "1", "yes", "on"]) {
      assert.throws(() => resolveLpEnabled({ LP_ENABLED: typo }), /LP_ENABLED/u);
    }
  });
});

describe("resolveLpAddresses — boot throws, never a request", () => {
  const chain56 = { chainId: 56, keyStore: KEY_STORE, routerV3: ROUTER_V3, wbnb: WBNB };

  it("chain 56 resolves the bytecode-verified defaults", () => {
    const resolved = resolveLpAddresses({}, chain56);
    assert.equal(resolved.nfpm, NFPM_56);
    assert.equal(resolved.factory, PANCAKE_V3_FACTORY_56);
    assert.equal(resolved.quoterV2, PANCAKE_V3_QUOTER_V2_56);
    assert.equal(resolved.routerV3, ROUTER_V3);
    assert.equal(resolved.wbnb, WBNB);
  });

  it("a malformed override fails the boot with the variable named", () => {
    assert.throws(
      () => resolveLpAddresses({ LP_NFPM: "0xnotanaddress" }, chain56),
      /LP_NFPM/u,
    );
    assert.throws(
      () => resolveLpAddresses({ LP_V3_FACTORY: zeroAddress }, chain56),
      /LP_V3_FACTORY.*zero/u,
    );
    // A "quoter" pointed at the registry that bounds every session is refused.
    assert.throws(
      () => resolveLpAddresses({ LP_QUOTER_V2: KEY_STORE }, chain56),
      /LP_QUOTER_V2.*key registry/u,
    );
  });

  it("a chain with no defaults and no overrides refuses to start", () => {
    assert.throws(
      () => resolveLpAddresses({}, { chainId: 97, keyStore: KEY_STORE, routerV3: ROUTER_V3, wbnb: WBNB }),
      /LP_NFPM.*LP_V3_FACTORY.*LP_QUOTER_V2/u,
    );
    // A missing router/WBNB is named too — a partial LP venue never boots.
    assert.throws(
      () => resolveLpAddresses({}, { chainId: 56, keyStore: KEY_STORE }),
      /VENUE_PANCAKE_ROUTER_V3.*VENUE_WBNB/u,
    );
    // With every override supplied, an exotic chain resolves.
    const resolved = resolveLpAddresses(
      {
        LP_NFPM: NFPM_56,
        LP_V3_FACTORY: PANCAKE_V3_FACTORY_56,
        LP_QUOTER_V2: PANCAKE_V3_QUOTER_V2_56,
      },
      { chainId: 97, keyStore: KEY_STORE, routerV3: ROUTER_V3, wbnb: WBNB },
    );
    assert.equal(resolved.nfpm, NFPM_56);
  });
});

describe("the 404 posture without LP deps", () => {
  it("LP routes answer the same not_found an unknown path gets", async () => {
    // No `lp` on the harness ⇒ `createServer` receives no LP deps — the
    // production shape of LP_ENABLED unset.
    const harness = await createHarness();
    const open = await call(harness, `/agents/${AGENT_ID}/lp/open`, {
      method: "POST",
      body: { anything: true },
      execToken: EXEC_TOKEN,
    });
    assert.equal(open.status, 404);
    assert.equal(errorCode(open.body), "not_found");

    const view = await call(harness, `/agents/${AGENT_ID}/lp`);
    assert.equal(view.status, 404);
    assert.equal(errorCode(view.body), "not_found");

    const unknown = await call(harness, `/agents/${AGENT_ID}/no-such-route`);
    assert.equal(unknown.status, 404);
    assert.equal(errorCode(unknown.body), errorCode(view.body));
  });
});
