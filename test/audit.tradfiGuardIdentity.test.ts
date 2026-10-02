import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import type { Hex } from "viem";
import { assertTradfiGuardRuntimeExact, TRADFI_BINANCE_FLASH_ROUTER_56 } from "../src/trade/guard.js";
import { USDT_56 } from "../src/trade/settlement.js";

it("guard identity binds internal immutable occurrences, not just getter constants", async () => {
  const compiler = (await import("solc")).default as unknown as { compile(input: string): string };
  const source = await readFile(new URL("../contracts/TradFiSwapGuard.sol", import.meta.url), "utf8");
  const compiled = JSON.parse(compiler.compile(JSON.stringify({ language: "Solidity",
    sources: { "TradFiSwapGuard.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: false, evmVersion: "paris",
      metadata: { bytecodeHash: "none", appendCBOR: false },
      outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } } },
  }))) as { contracts: Record<string, Record<string, { evm: { deployedBytecode: { object: string } } }>> };
  const template = compiled.contracts["TradFiSwapGuard.sol"]?.["TradFiSwapGuard"]?.evm.deployedBytecode.object;
  assert.ok(template);
  const patch = (bytes: string, offset: number, value: string): string => bytes.slice(0, offset * 2)
    + value.slice(2).toLowerCase().padStart(64, "0") + bytes.slice((offset + 32) * 2);
  let exact = template;
  for (const offset of [297, 1913, 258, 2656, 2764]) exact = patch(exact, offset, TRADFI_BINANCE_FLASH_ROUTER_56);
  for (const offset of [173, 471]) exact = patch(exact, offset, USDT_56);
  const check = (body: string): void => assertTradfiGuardRuntimeExact({ deployedRuntime: `0x${body}` as Hex,
    router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_ROUTER_56, canonicalUSDT: USDT_56 });
  assert.doesNotThrow(() => check(exact));
  for (const internalOffset of [1913, 2656, 2764, 471]) {
    assert.throws(() => check(patch(exact, internalOffset, "0x000000000000000000000000000000000000dEaD")),
      /immutable word mismatch/, `internal slot ${internalOffset} must be bound independently of getters`);
  }
  assert.throws(() => check(`00${exact.slice(2)}`), /implementation hash/);
  assert.throws(() => check(`${exact}00`), /runtime length/);
});
