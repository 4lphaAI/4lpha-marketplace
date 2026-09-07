/**
 * `scripts/live-lending.ts` — the OPERATOR CLI's safety surface, offline.
 *
 * What this file is for: the CLI is the thing a person will point at BNB
 * mainnet at 2 a.m. with a funded wallet, so the properties worth pinning are
 * the ones that stop a keystroke from becoming a transaction —
 *
 *   1. every subcommand that can submit REFUSES without `--yes-live`, and the
 *      refusal carries the figures rather than a prompt;
 *   2. no submitting call in any handler is reachable BEFORE its gate. This is
 *      asserted STRUCTURALLY, over the source, because the alternative is
 *      driving a spending path in a test — which this repo does not do;
 *   3. an unknown flag refuses the run before anything is constructed;
 *   4. the boot gates fail closed and quote the rule they enforce;
 *   5. `preview` prints the EXPOSURE PRODUCT (cap × periods), not the rate.
 *      FINDINGS (r): the rate on its own is the number that hid 7× the
 *      authority an operator thought they were granting.
 *
 * Nothing here opens a socket, a database or a wallet: the CLI's pure layer is
 * exported precisely so this suite needs none of them.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LENDING_CLI_COMMANDS,
  LENDING_CLI_KNOWN_FLAGS,
  LENDING_CLI_LIVE_COMMANDS,
  LENDING_CLI_STORELESS_COMMANDS,
  assertKnownFlags,
  checkBootGates,
  censusRows,
  commandIsLive,
  isYesLive,
  lendingPreviewReport,
  parseFlags,
  unknownFlags,
  yesLiveGate,
  yesLiveRefusal,
  type LendingCliCommand,
} from "../scripts/live-lending.js";
import {
  LENDING_RESERVE_BPS_DEFAULT,
  MAX_VENUS_SESSION_SECONDS,
  VENUS_RECORDED_ROUTING,
} from "../src/ops/policy.js";
import type { TradeEnv } from "../src/ops/config.js";

const USDT = "0x55d398326f99059fF775485246999027B3197955" as const;
const VUSDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255" as const;
const VBNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36" as const;

const SOURCE = readFileSync(new URL("../scripts/live-lending.ts", import.meta.url), "utf8");

/** A fully-enabled environment, so each gate test can break exactly one thing. */
function goodEnv(overrides: Readonly<Record<string, string | undefined>> = {}): TradeEnv {
  return {
    LENDING_ENABLED: "true",
    LP_ENABLED: "true",
    HIRE_ENABLED: "true",
    // `resolveHireEnabled` requires it, and `resolveLendingEnabled` requires
    // `HIRE_ENABLED` — so the guard's boot transitively requires passkeys.
    PASSKEY_ENABLED: "true",
    DATABASE_URL: "postgres://localhost/execution",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. The `--yes-live` matrix                                                 */
/* -------------------------------------------------------------------------- */

test("every subcommand that can submit is in the live set, and the read-only ones are not", () => {
  // The list is written out rather than derived, so ADDING a spending
  // subcommand and forgetting the gate fails here instead of on mainnet.
  assert.deepEqual(
    [...LENDING_CLI_LIVE_COMMANDS].sort(),
    ["arm", "provision", "retire", "settings", "worker"],
  );
  for (const command of ["census", "guardable", "preview", "status"] as const) {
    assert.equal(
      LENDING_CLI_LIVE_COMMANDS.has(command),
      false,
      `${command} is read-only and must not be gated as a spending path`,
    );
  }
});

test("every spending subcommand REFUSES without --yes-live, and proceeds with it", () => {
  for (const command of LENDING_CLI_LIVE_COMMANDS) {
    const bare = parseFlags(
      command === "worker"
        ? ["--once", "--agent-id", "guard-1"]
        : ["--agent-id", "guard-1", "--budget", "0.05"],
    );
    assert.equal(isYesLive(bare), false);
    const refusal = yesLiveGate({
      command, flags: bare, chainId: 56, networkLabel: "mainnet",
      wouldSpend: "spend 0.05 BNB",
    });
    if (command === "worker") {
      // `worker` is the one whose default is a REHEARSAL, so the gate lets it
      // through — and `commandIsLive` says it will write nothing.
      assert.equal(refusal, null);
      assert.equal(commandIsLive(command, bare), false);
    } else {
      assert.ok(refusal !== null, `${command} must refuse without --yes-live`);
      assert.match(refusal, /Nothing was sent\./u);
      assert.match(refusal, /spend 0\.05 BNB/u);
    }
    const armed = parseFlags([...bare.keys()].flatMap((key) => [`--${key}`, bare.get(key) ?? ""])
      .concat(["--yes-live"]));
    assert.equal(
      yesLiveGate({
        command, flags: armed, chainId: 56, networkLabel: "mainnet",
        wouldSpend: "spend 0.05 BNB",
      }),
      null,
      `${command} must proceed once --yes-live is present`,
    );
  }
});

test("`worker` rehearses by default and only --yes-live without --dry-run makes it live", () => {
  assert.equal(commandIsLive("worker", parseFlags(["--once"])), false);
  assert.equal(commandIsLive("worker", parseFlags(["--once", "--dry-run"])), false);
  assert.equal(
    commandIsLive("worker", parseFlags(["--once", "--yes-live", "--dry-run"])),
    false,
    "--dry-run must win over --yes-live: the safer of two contradicting flags",
  );
  assert.equal(commandIsLive("worker", parseFlags(["--once", "--yes-live"])), true);
});

test("the refusal names the command, the chain, the figures and the flag — and is not a prompt", () => {
  const text = yesLiveRefusal(
    "arm",
    56,
    "mainnet",
    "submit ONE batch that swaps 0.04 BNB to USDT and mints vUSDT",
  );
  assert.match(text, /REFUSED: `arm` acts for real on chain 56 \(mainnet\)/u);
  assert.match(text, /swaps 0\.04 BNB to USDT/u);
  assert.match(text, /Re-run with --yes-live/u);
  assert.match(text, /Nothing was sent\./u);
  // A prompt would be a question. This is a refusal.
  assert.equal(/\?\s*$/u.test(text.trim()), false);
});

/* -------------------------------------------------------------------------- */
/* 2. Nothing submits before its gate — asserted over the source              */
/* -------------------------------------------------------------------------- */

/** Every call in this CLI that can reach a relay, a signer or the journal. */
const SUBMITTING_CALLS = [
  "ownerPost(",
  "grantSession(",
  "runLendingWorkerOnce(",
] as const;

function handlerBody(name: string): string {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `handler ${name} not found`);
  // The next top-level `async function` (or the entry block) ends it. Handlers
  // are declared consecutively, so this is exact enough to order two calls.
  const nextFunction = SOURCE.indexOf("\nasync function ", start + 1);
  const nextSection = SOURCE.indexOf("\nfunction ", start + 1);
  const candidates = [nextFunction, nextSection, SOURCE.length].filter((index) => index > start);
  return SOURCE.slice(start, Math.min(...candidates));
}

test("each spending handler calls requireYesLive BEFORE anything that can submit", () => {
  const handlers: Readonly<Record<string, string>> = {
    provision: "commandProvision",
    arm: "commandArm",
    settings: "commandSettings",
    retire: "commandRetire",
    worker: "commandWorker",
  };
  for (const [command, name] of Object.entries(handlers)) {
    const body = handlerBody(name);
    const gate = body.indexOf("requireYesLive(");
    assert.notEqual(gate, -1, `${command}: no requireYesLive gate`);
    for (const call of SUBMITTING_CALLS) {
      const at = body.indexOf(call);
      if (at === -1) continue;
      assert.ok(
        at > gate,
        `${command}: \`${call}\` appears at ${at}, before the --yes-live gate at ${gate}. `
          + "A submitting call above the gate spends on a forgotten flag.",
      );
    }
  }
});

test("no read-only handler contains a submitting call at all", () => {
  for (const name of ["commandCensus", "commandGuardable", "commandPreview", "commandStatus"]) {
    const body = handlerBody(name);
    for (const call of SUBMITTING_CALLS) {
      assert.equal(
        body.includes(call),
        false,
        `${name} must not contain ${call}: it is documented READ-ONLY`,
      );
    }
  }
});

test("the entry point checks the flag set before dispatching to any handler", () => {
  const main = SOURCE.slice(SOURCE.indexOf("async function main("));
  const check = main.indexOf("assertKnownFlags(");
  const dispatch = main.indexOf("switch (command)");
  assert.ok(check !== -1 && dispatch !== -1);
  assert.ok(
    check < dispatch,
    "assertKnownFlags must run before the switch; a misspelled flag must not reach a handler",
  );
});

/* -------------------------------------------------------------------------- */
/* 3. Unknown flags refuse                                                    */
/* -------------------------------------------------------------------------- */

test("an unknown flag refuses the run and names both the typo and the known set", () => {
  const flags = parseFlags(["--agent-id", "guard-1", "--yeslive"]);
  assert.deepEqual(unknownFlags("arm", flags), ["yeslive"]);
  assert.throws(
    () => { assertKnownFlags("arm", flags); },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Unknown flag\(s\) for `arm`: --yeslive/u);
      assert.match(error.message, /--yes-live/u);
      assert.match(error.message, /never silently ignored/u);
      return true;
    },
  );
});

test("`--yes-live` is known to every subcommand, including the read-only ones", () => {
  for (const command of LENDING_CLI_COMMANDS) {
    assert.ok(
      LENDING_CLI_KNOWN_FLAGS[command].includes("yes-live"),
      `${command} must accept --yes-live so passing it is never a typo refusal`,
    );
  }
});

test("a known flag on one subcommand is still unknown on another", () => {
  // `--accept-partial` belongs to `retire` alone: on `arm` it would be a
  // meaningless word an operator believed had an effect.
  assert.deepEqual(unknownFlags("retire", parseFlags(["--accept-partial"])), []);
  assert.deepEqual(unknownFlags("arm", parseFlags(["--accept-partial"])), ["accept-partial"]);
});

test("the flag parser reads --a b, --a=b and bare --a", () => {
  const flags = parseFlags(["--agent-id", "guard-1", "--budget=0.05", "--yes-live"]);
  assert.equal(flags.get("agent-id"), "guard-1");
  assert.equal(flags.get("budget"), "0.05");
  assert.equal(flags.get("yes-live"), "true");
});

/* -------------------------------------------------------------------------- */
/* 4. The boot gates                                                          */
/* -------------------------------------------------------------------------- */

test("LENDING_ENABLED unset or false refuses every subcommand THAT ACTS", () => {
  for (const value of [undefined, "false"]) {
    for (const command of LENDING_CLI_COMMANDS) {
      const refusal = checkBootGates({
        env: goodEnv({ LENDING_ENABLED: value }),
        chainId: 56,
        command,
      });
      if (LENDING_CLI_STORELESS_COMMANDS.has(command)) continue;
      assert.ok(refusal !== null, `${command} must refuse with LENDING_ENABLED=${String(value)}`);
      assert.match(refusal, /LENDING_ENABLED/u);
    }
  }
});

/**
 * The read-only probes are how a deployment is checked BEFORE it is enabled.
 * Gating them on the flag made the runbook gate that exists to catch a moved
 * census — or an unset VENUS_PRIME_ADDRESS — impossible to run in the state it
 * is written for.
 */
test("the read-only chain probes run with the guard OFF", () => {
  for (const value of [undefined, "false"]) {
    for (const command of LENDING_CLI_STORELESS_COMMANDS) {
      assert.equal(
        checkBootGates({ env: goodEnv({ LENDING_ENABLED: value }), chainId: 56, command }),
        null,
        `${command} must run with LENDING_ENABLED=${String(value)}`,
      );
    }
  }
});

test("a probe still refuses off chain 56, and still refuses a malformed flag", () => {
  const wrongChain = checkBootGates({ env: goodEnv({ LENDING_ENABLED: undefined }), chainId: 97, command: "census" });
  assert.ok(wrongChain !== null);
  assert.match(wrongChain, /chain-56 only/u);
  const malformed = checkBootGates({ env: goodEnv({ LENDING_ENABLED: "TRUE" }), chainId: 56, command: "census" });
  assert.ok(malformed !== null);
  assert.match(malformed, /must be exactly "true" or "false"/u);
});

test('a malformed LENDING_ENABLED is a refusal, not a falsy default', () => {
  const refusal = checkBootGates({
    env: goodEnv({ LENDING_ENABLED: "TRUE" }),
    chainId: 56,
    command: "status",
  });
  assert.ok(refusal !== null);
  assert.match(refusal, /must be exactly "true" or "false"/u);
});

test("LENDING_ENABLED without LP_ENABLED or HIRE_ENABLED refuses with the resolver's own text", () => {
  const lp = checkBootGates({
    env: goodEnv({ LP_ENABLED: "false" }),
    chainId: 56,
    command: "census",
  });
  assert.ok(lp !== null);
  assert.match(lp, /LP_ENABLED is not/u);
  assert.match(lp, /router, WBNB and QuoterV2|QuoterV2/u);

  const hire = checkBootGates({
    env: goodEnv({ HIRE_ENABLED: "false" }),
    chainId: 56,
    command: "census",
  });
  assert.ok(hire !== null);
  assert.match(hire, /HIRE_ENABLED is not/u);
  assert.match(hire, /lending-v1 hire preset/u);
});

test("any chain but 56 refuses, and the refusal says why the census is meaningless elsewhere", () => {
  const refusal = checkBootGates({ env: goodEnv(), chainId: 97, command: "census" });
  assert.ok(refusal !== null);
  assert.match(refusal, /chain-56 only/u);
  assert.match(refusal, /chain 97/u);
  assert.match(refusal, /census was taken on BNB mainnet/u);
});

test("DATABASE_URL is required for every subcommand that touches the guard row", () => {
  for (const command of LENDING_CLI_COMMANDS) {
    const refusal = checkBootGates({
      env: goodEnv({ DATABASE_URL: "" }),
      chainId: 56,
      command,
    });
    if (LENDING_CLI_STORELESS_COMMANDS.has(command)) {
      assert.equal(refusal, null, `${command} writes nothing and must not need a database`);
      continue;
    }
    assert.ok(refusal !== null, `${command} must refuse without DATABASE_URL`);
    assert.match(refusal, /DATABASE_URL is unset/u);
    assert.match(refusal, /worker's queue/u);
  }
});

test("a fully enabled chain-56 environment passes every gate", () => {
  for (const command of LENDING_CLI_COMMANDS) {
    assert.equal(checkBootGates({ env: goodEnv(), chainId: 56, command }), null);
  }
});

/* -------------------------------------------------------------------------- */
/* 5. `preview` prints the exposure product                                   */
/* -------------------------------------------------------------------------- */

const PREVIEW_INPUT = {
  budgetWei: 50_000_000_000_000_000n, // 0.05 BNB
  reserveBps: LENDING_RESERVE_BPS_DEFAULT,
  rescueReserveCount: 6,
  mintUsdtWei: 34_000_000_000_000_000_000n, // ~34 USDT
  tierBuyBackUsdtWei: 8_500_000_000_000_000_000n,
  capDayWei: 500_000_000_000_000_000n, // 0.5 BNB/day
  reserveCapWei: 200_000_000_000_000_000_000n, // 200 USDT/day
  usdt: USDT,
  ttlSec: MAX_VENUS_SESSION_SECONDS,
} as const;

test("the preview report carries the EXPOSURE PRODUCT, cap x periods, not the rate alone", () => {
  const lines = lendingPreviewReport(PREVIEW_INPUT).join("\n");
  assert.match(lines, /EXPOSURE PRODUCT/u);
  assert.match(lines, /FINDINGS \(r\)/u);
  // 0.5 BNB/day over the 7-day session ceiling is 3.5 BNB of authority — the
  // whole point of printing the product.
  assert.match(lines, /7 rolling day\(s\)/u);
  assert.match(lines, /0\.5 BNB\/day × 7 = 3\.5 BNB over this session/u);
  assert.match(lines, /1400 USDT/u);
  assert.match(lines, new RegExp(USDT, "u"));
});

test("the preview report states the custody sentence and the early-warning caveat", () => {
  const lines = lendingPreviewReport(PREVIEW_INPUT).join("\n");
  assert.match(lines, /UNCONSTRAINED SPENDER/u);
  assert.match(lines, /UNCONSTRAINED RECIPIENT/u);
  assert.match(lines, /a BUDGET, not a gate/u);
  assert.match(lines, /EARLY WARNING, NOT A GUARANTEE/u);
  assert.match(lines, /NEVER refused for want of headroom/u);
});

test("the preview report shows the reserve split, the mint estimate and both cap floors", () => {
  const lines = lendingPreviewReport(PREVIEW_INPUT).join("\n");
  // 20 % of 0.05 BNB is 0.01 as the tier, 0.04 as the supply leg.
  assert.match(lines, /BNB tier 0\.01 \/ supply leg 0\.04 BNB/u);
  assert.match(lines, /mint estimate\s+: 34 USDT/u);
  assert.match(lines, /USDT cap floor\s+: [\d.]+ USDT/u);
  assert.match(lines, /native cap floor\s+: [\d.]+ BNB/u);
  assert.match(lines, /sizing\s+: ok/u);
});

test("an under-sized cap surfaces as the sizing refusal, with the shortfall in the text", () => {
  const lines = lendingPreviewReport({
    ...PREVIEW_INPUT,
    capDayWei: 1_000_000_000_000_000n, // far below the floor
  }).join("\n");
  assert.match(lines, /sizing\s+: REFUSED/u);
  assert.match(lines, /short by \d+ wei/u);
});

test("naming no caps prices the preview AT THE FLOOR and says so", () => {
  const lines = lendingPreviewReport({
    ...PREVIEW_INPUT,
    capDayWei: null,
    reserveCapWei: null,
  }).join("\n");
  assert.match(lines, /priced AT THE FLOOR — you named no cap/u);
  // Priced at its own floor, the check must pass: the floor is by construction
  // the smallest cap that clears it.
  assert.match(lines, /sizing\s+: ok/u);
});

/* -------------------------------------------------------------------------- */
/* 6. The census comparison                                                   */
/* -------------------------------------------------------------------------- */

function observation(overrides: {
  readonly selectorsPresent?: ReadonlyMap<string, boolean>;
  readonly usdtFromUnderlying?: `0x${string}`;
  readonly claimVenusFacet?: `0x${string}`;
  readonly liquidity?: bigint;
} = {}): Parameters<typeof censusRows>[0] {
  const present = new Map<string, boolean>();
  for (const signature of ["mint(uint256)", "redeemUnderlying(uint256)", "repayBorrowBehalf(address,uint256)"]) {
    present.set(`${VUSDT.toLowerCase()}:${signature}`, true);
  }
  present.set(`${VBNB.toLowerCase()}:repayBorrowBehalf(address)`, true);
  return {
    blockNumber: 120_362_697n,
    selectorsPresent: overrides.selectorsPresent ?? present,
    vUsdt: VUSDT,
    vBnb: VBNB,
    usdtFromUnderlying: overrides.usdtFromUnderlying ?? USDT,
    usdtFromBoot: USDT,
    routing: {
      claimVenusFacet: overrides.claimVenusFacet ?? VENUS_RECORDED_ROUTING.claimVenusFacet,
      primeImplementation: VENUS_RECORDED_ROUTING.primeImplementation,
      vTokenImplementations: [[VUSDT, VENUS_RECORDED_ROUTING.vBep20Implementation]],
    },
    pool: {
      address: "0x172fcD41E0913e95784454622d1c3724f546f849",
      liquidity: overrides.liquidity ?? 2_993_458_403_750_207_967_826_780n,
      token0: USDT,
    },
  };
}

test("a matching census is all PASS and covers every granted selector", () => {
  const rows = censusRows(observation());
  assert.equal(rows.every((row) => row.pass), true);
  assert.ok(rows.some((row) => row.name.includes("mint(uint256)")));
  assert.ok(rows.some((row) => row.name.includes("repayBorrowBehalf(address,uint256)")));
  assert.ok(rows.some((row) => row.name.includes("repayBorrowBehalf(address)")));
  assert.ok(rows.some((row) => row.name.includes("claimVenus facet")));
  assert.ok(rows.some((row) => row.name.includes("pinned WBNB/USDT pool")));
});

test("a moved facet, an absent selector, a wrong underlying and an empty pool each FAIL", () => {
  const movedFacet = censusRows(
    observation({ claimVenusFacet: "0x000000000000000000000000000000000000dEaD" }),
  );
  assert.equal(movedFacet.find((row) => row.name.includes("claimVenus facet"))?.pass, false);

  const missing = new Map<string, boolean>([
    [`${VUSDT.toLowerCase()}:mint(uint256)`, false],
  ]);
  const absent = censusRows(observation({ selectorsPresent: missing }));
  assert.equal(absent.filter((row) => row.pass === false).length >= 4, true);

  const wrongUsdt = censusRows(
    observation({ usdtFromUnderlying: "0x000000000000000000000000000000000000dEaD" }),
  );
  assert.equal(wrongUsdt.find((row) => row.name.includes("underlying"))?.pass, false);

  const dryPool = censusRows(observation({ liquidity: 0n }));
  assert.equal(dryPool.find((row) => row.name.includes("pool"))?.pass, false);
});

/* -------------------------------------------------------------------------- */
/* 7. The command table itself                                                */
/* -------------------------------------------------------------------------- */

test("every declared subcommand has a known-flag entry and a handler", () => {
  for (const command of LENDING_CLI_COMMANDS) {
    assert.ok(
      Array.isArray(LENDING_CLI_KNOWN_FLAGS[command as LendingCliCommand]),
      `${command} has no flag table`,
    );
    const handler = `command${command.charAt(0).toUpperCase()}${command.slice(1)}`;
    assert.ok(SOURCE.includes(`async function ${handler}(`), `${command} has no handler`);
    assert.ok(SOURCE.includes(`await ${handler}(flags)`), `${command} is not dispatched`);
  }
});
