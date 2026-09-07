/**
 * PHASE4 — the operator scripts' contracts (`PHASE4-AUDIT.md` A5's last
 * third), in the house style of `test/lp.operatorContract.test.ts`: the
 * scripts self-execute `main()` on import, so their contracts are pinned by
 * reading the SOURCE and asserting structure — with the A19 lesson applied:
 * never a bare "the string exists" grep where an ORDER can be asserted, since
 * a gate that exists after the spend is a gate that does not exist.
 *
 * The three contracts that carry money:
 *  - a misspelled flag REFUSES rather than silently spending where the
 *    operator meant to rehearse;
 *  - every gate (confirm, enablement, chain, DB, key material) fires before
 *    anything is constructed, and the routing census before the grant;
 *  - a private key is never printed — the ADDRESS is.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const worker = await readFile(
  new URL("../scripts/venus-worker.ts", import.meta.url),
  "utf8",
);
const provision = await readFile(
  new URL("../scripts/provision-venus-agent.ts", import.meta.url),
  "utf8",
);
const liveVenus = await readFile(
  new URL("../scripts/live-venus.ts", import.meta.url),
  "utf8",
);

/** Index of `needle`, asserting it exists at all. */
function at(source: string, needle: string, label?: string): number {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `missing: ${label ?? needle}`);
  return index;
}

/** Assert `first` appears strictly BEFORE `second` in `source`. */
function ordered(source: string, first: string, second: string): void {
  assert.ok(
    at(source, first) < at(source, second),
    `"${first.slice(0, 48)}…" must come BEFORE "${second.slice(0, 48)}…"`,
  );
}

describe("venus-worker operator contract", () => {
  it("an unknown flag REFUSES, naming the known set — a misspelled --dry-run must not spend", () => {
    assert.match(worker, /Unknown argument\(s\): \$\{unknown\.join\(", "\)\}/u);
    assert.match(worker, /Known flags: --dry-run, --once\./u);
    // And the refusal is thrown, not logged-and-continued.
    const refusal = worker.slice(at(worker, "Unknown argument(s)") - 200, at(worker, "Unknown argument(s)"));
    assert.match(refusal, /throw new Error/u);
  });

  it("every boot gate fires before any store or reader is constructed", () => {
    // enablement -> DATABASE_URL -> chain-56, all before the first store.
    ordered(worker, 'resolveVenusEnabled(process.env)', "createAgentStore()");
    ordered(worker, '"DATABASE_URL is required', "createAgentStore()");
    ordered(worker, "chain-56 only", "createAgentStore()");
    ordered(worker, "chain-56 only", "createVenusChainReaders(");
  });

  it("the market universe comes from the SHARED seam — the F2 sentence, kept true", () => {
    assert.match(worker, /from "\.\.\/src\/venus\/wiring\.js"/u);
    ordered(worker, "venusMarketUniverse(settingsStore", "createVenusChainReaders(");
  });

  it("the one-worker MONEY invariant is printed at boot, before the first cycle", () => {
    ordered(
      worker,
      "run EXACTLY ONE venus-worker per database",
      "runVenusWorkerOnce(deps)",
    );
    assert.match(worker, /MONEY invariant, not a tidiness one/u);
  });

  it("the daemon loop uses the SHARED scheduler, not its own sleep arithmetic", () => {
    // The eternal-sleep bug lived in the shared helper and is pinned by
    // venus.scheduler.test.ts; what the SCRIPT owes is to call that helper
    // rather than reinventing boundary math inline.
    assert.match(worker, /await sleepUntilNextVenusCycle\(\{/u);
    assert.ok(
      !/setInterval\(/u.test(worker),
      "the worker must not schedule with setInterval — overrun cycles would overlap",
    );
    // `--once` breaks BEFORE the sleep: one cycle means one cycle.
    ordered(worker, "if (once || stopping) break;", "await sleepUntilNextVenusCycle({");
  });

  it("a cycle failure is logged and the daemon LIVES — one bad read must not kill the guard", () => {
    const loop = worker.slice(at(worker, "for (;;) {"), at(worker, "await Promise.all(["));
    assert.match(loop, /catch \(error\)/u);
    assert.match(loop, /cycle failed/u);
    assert.match(loop, /sanitizeMessage/u);
  });
});

describe("provision-venus-agent operator contract", () => {
  it("the mainnet confirmation is the FIRST gate in main — before anything exists to spend", () => {
    const main = provision.slice(at(provision, "async function main("));
    ordered(main, "assertMainnetConfirmed()", "resolveVenusEnabled");
    ordered(main, "assertMainnetConfirmed()", "createVenusChainReaders(");
    ordered(main, "assertMainnetConfirmed()", "grantSession(");
  });

  it("enablement, chain-56, DATABASE_URL and EXECUTION_MASTER_KEY all refuse before any chain read", () => {
    const main = provision.slice(at(provision, "async function main("));
    for (const gate of [
      "resolveVenusEnabled",
      "chain-56 only",
      "DATABASE_URL is required",
      "EXECUTION_MASTER_KEY is required",
    ]) {
      ordered(main, gate, "createPublicClient(");
      ordered(main, gate, "createVenusChainReaders(");
    }
  });

  it("vBNB is validated against the CHAIN by symbol before any market is split — the calldata shape is never guessed", () => {
    const main = provision.slice(at(provision, "async function main("));
    ordered(main, 'functionName: "symbol"', "for (const market of args.markets)");
    assert.match(main, /refusing to guess/iu);
  });

  it("a missing --token-cap refuses, and the refusal teaches WHY the cap is the bound", () => {
    assert.match(provision, /caps are SIZED, never defaulted/u);
    assert.match(provision, /CallRule cannot constrain the spender/u);
  });

  it("the routing census is read and enforced BEFORE the grant — R3.12's whole point", () => {
    const main = provision.slice(at(provision, "async function main("));
    ordered(main, "readRoutingCensus(", "venusSessionSpec({");
    ordered(main, "UNCHANGED since the recorded census", "grantSession(");
  });

  it("FINDINGS (r): the exposure PRODUCT is printed before the grant, never the rate alone", () => {
    const main = provision.slice(at(provision, "async function main("));
    ordered(main, "venusExposureProduct(", "grantSession(");
    assert.match(main, /cap x \$\{exposure\.periods\} periods/u);
    assert.match(main, /BUDGET, not a gate/u);
  });

  it("a zero-balance wallet refuses BEFORE the grant — the grant costs gas this wallet pays", () => {
    const main = provision.slice(at(provision, "async function main("));
    ordered(main, "balance === 0n", "grantSession(");
    assert.match(main, /Fund it and re-run/u);
  });

  it("the session key is never printed — its ADDRESS is, and the key goes to .env", () => {
    // The one console.log that mentions the session key must derive the
    // ADDRESS. Printing `session.key` itself would put a spendable secret in
    // scrollback and CI logs.
    assert.match(
      provision,
      /session key {4}: \$\{privateKeyToAccount\(session\.key\)\.address\}/u,
    );
    const prints = provision
      .split("\n")
      .filter((line) => /console\.(log|error)/u.test(line) && /session\.key/u.test(line));
    for (const line of prints) {
      assert.match(
        line,
        /privateKeyToAccount\(session\.key\)\.address/u,
        `a print touches session.key without deriving the address: ${line.trim()}`,
      );
    }
  });

  it("REVISION 4 (V9) — the script says vBNB is REPAY-ONLY, in usage AND at grant time", () => {
    assert.ok(provision.includes("naming vBNB in --markets grants REPAY-ONLY"));
    ordered(provision, "vBNB is granted REPAY-ONLY", "grantSession(");
  });

  it("the grant lands before the row is persisted, and the encrypted key write follows the row", () => {
    const main = provision.slice(at(provision, "async function main("));
    ordered(main, "grantSession(", "createAgent(");
    ordered(main, "createAgent(", "putAgentSessionKey(");
  });
});

describe("live-venus operator contract", () => {
  it("the command set is CLOSED and an unknown command gets usage, not a guess", () => {
    const commands = liveVenus.slice(
      at(liveVenus, "const COMMANDS = new Set(["),
      liveVenus.indexOf("]);", at(liveVenus, "const COMMANDS = new Set([")),
    );
    for (const command of ["status", "simulate", "settings", "rescue", "untrack-sweep"]) {
      assert.match(commands, new RegExp(`"${command}"`, "u"));
    }
    assert.match(liveVenus, /Usage: npm run live-venus/u);
  });

  it("the --yes-live gate is checked FIRST — nothing is constructed on the way to discovering a forgotten flag", () => {
    const main = liveVenus.slice(at(liveVenus, "async function main("));
    assert.match(main, /Nothing was constructed and nothing ran\./u);
    ordered(main, 'flag("yes-live")', "resolveVenusEnabled");
    ordered(main, 'flag("yes-live")', "createVenusChainReaders(");
    // And exactly the spending/mutating commands are gated.
    assert.match(
      liveVenus,
      /LIVE_COMMANDS = new Set\(\["rescue", "untrack-sweep"\]\)/u,
    );
  });

  it("rescue on mainnet additionally requires the explicit mainnet confirmation", () => {
    const main = liveVenus.slice(at(liveVenus, "async function main("));
    ordered(main, 'command === "rescue" && isMainnet) assertMainnetConfirmed()', "createVenusChainReaders(");
  });

  it("simulate IS the dry-run — the flagged rehearsal maps to the worker's write-nothing mode", () => {
    assert.match(liveVenus, /dryRun: command === "simulate"/u);
  });

  it("enablement refuses before construction, matching the worker's posture", () => {
    const main = liveVenus.slice(at(liveVenus, "async function main("));
    ordered(main, "resolveVenusEnabled", "createVenusChainReaders(");
    assert.match(main, /live-venus refuses on a deployment that has not enabled the guard/u);
  });
});
