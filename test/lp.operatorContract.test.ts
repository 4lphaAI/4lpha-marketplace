/** Operator-surface regressions for the owner recovery commands (offline). */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const source = await readFile(new URL("../scripts/live-lp.ts", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

describe("live-lp recovery operator contract", () => {
  it("abandon previews the worker fence, position/basis and predicted disposition before signing", () => {
    const command = section("async function cmdAbandon", "async function cmdResolve");
    const gate = command.indexOf("requireYesLive(");
    assert.notEqual(gate, -1);
    const preview = command.slice(0, gate);

    assert.match(preview, /STOP the LP worker first/);
    assert.match(preview, /state=\$\{position\.state\} basisWei=/);
    assert.match(preview, /verifyLpAbandonSequence/);
    assert.match(preview, /predicted/);
    assert.match(preview, /no row observed/);
    assert.doesNotMatch(preview, /never begun/i);

    const finalGate = command.slice(gate);
    assert.match(finalGate, /liquidity-removing step already COMMITTED/);
    assert.match(finalGate, /abandoned.*sequence is an open/s);
    assert.match(finalGate, /CLOSES the.*position row and ZEROES its basis/s);
  });

  it("runtime help exposes abandon and describes both resolve dispositions honestly", () => {
    const usage = source.slice(source.indexOf("const USAGE ="));
    assert.match(usage, /abandon\s+--agent-id/);
    assert.match(usage, /STOP the LP worker first/);
    assert.match(usage, /predicted close \/\s*restore-open \/ leave/);
    assert.match(usage, /Finalized direct evidence may ADVANCE/);
    assert.match(usage, /otherwise it ABANDONS/);
  });

  /**
   * PHASE3.12 B5, operator half. `live-lp harvest` reaches the SAME
   * `collect-fees.build` as the worker, so G2 covers it — but only because the
   * operator deps supply a real `currentTick` read rather than a placeholder.
   * `LpSagaMarket` makes omitting the field a compile error; this pins that it
   * comes from the pool state, so the refusal can never be decided on a
   * fabricated tick.
   */
  it("the operator harvest drives the shared saga on a real pool tick", () => {
    const command = section("async function cmdHarvest", "async function cmdRotate");
    assert.match(command, /runLpHarvest\(deps\.base, positionId\)/);
    const deps = section("async function operatorSagaDeps", "async function cmd");
    assert.match(deps, /currentTick: state\.currentTick/);
  });
});
