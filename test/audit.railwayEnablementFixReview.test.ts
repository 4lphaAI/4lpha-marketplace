import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { custom, getAddress } from "viem";
import { bsc } from "viem/chains";
import { createLpChainReaders } from "../src/lp/readers.js";
import { verifyRailwayBaseProvenance } from "../src/deployment/ociLayout.js";
import {
  type WorkerFence,
} from "../src/deployment/workerSingleton.js";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const BASE_PROVENANCE_FIXTURE = resolve(
  ROOT,
  "test/fixtures/railway/node-22.23.2-bookworm-slim-amd64",
);

function controllableFence(): Readonly<{ fence: WorkerFence; lose(): void }> {
  const controller = new AbortController();
  let fatal = false;
  return {
    fence: {
      signal: controller.signal,
      isFatal: () => fatal,
      assertOpen(): void {
        if (fatal) throw new Error("Worker singleton authority was lost.");
      },
    },
    lose(): void {
      fatal = true;
      controller.abort(new Error("Worker singleton authority was lost."));
    },
  };
}

function finalizedBlockJson(): Readonly<Record<string, unknown>> {
  return {
    number: "0x64",
    hash: `0x${"11".repeat(32)}`,
    parentHash: `0x${"22".repeat(32)}`,
    nonce: `0x${"00".repeat(8)}`,
    sha3Uncles: `0x${"33".repeat(32)}`,
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: `0x${"44".repeat(32)}`,
    stateRoot: `0x${"55".repeat(32)}`,
    receiptsRoot: `0x${"66".repeat(32)}`,
    miner: getAddress("0x1111111111111111111111111111111111111111"),
    mixHash: `0x${"77".repeat(32)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x0",
    gasUsed: "0x0",
    timestamp: "0x0",
    transactions: [],
    uncles: [],
    baseFeePerGas: null,
  };
}

test("audit Railway fix review: real LP reader cannot cross its next RPC boundary after lock loss", async () => {
  const authority = controllableFence();
  let blockEnteredResolve: (() => void) | undefined;
  const blockEntered = new Promise<void>((resolveEntered) => { blockEnteredResolve = resolveEntered; });
  let releaseBlock: (() => void) | undefined;
  const blockPaused = new Promise<void>((resolvePaused) => { releaseBlock = resolvePaused; });
  const methods: string[] = [];
  const transport = custom({
    async request({ method }) {
      methods.push(method);
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_getBlockByNumber") {
        blockEnteredResolve?.();
        await blockPaused;
        return finalizedBlockJson();
      }
      if (method === "eth_call") throw new Error("post-loss LP RPC crossed");
      throw new Error(`unexpected RPC ${method}`);
    },
  });
  const readers = createLpChainReaders({
    network: { chain: bsc, chainId: 56, publicRpcUrl: "https://fixture.invalid" },
    workerFence: authority.fence,
    transport: () => transport,
    nfpm: getAddress("0x2222222222222222222222222222222222222222"),
    factory: getAddress("0x3333333333333333333333333333333333333333"),
    quoterV2: getAddress("0x4444444444444444444444444444444444444444"),
    twapWindowSeconds: 300,
  });

  const running = readers.ownerOf(1n);
  await blockEntered;
  authority.lose();
  releaseBlock?.();
  await assert.rejects(running, /authority was lost/u);
  assert.deepEqual(methods, ["eth_chainId", "eth_getBlockByNumber"],
    "the real sequential eth_call boundary crossed after worker authority was lost");
});

test("audit Railway fix review: the production adapter artifact contains no dependency injection seam", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-fix-review-adapter-"));
  const bundle = join(temporary, "adapter.mjs");
  try {
    await run(process.execPath, [
      "--import",
      "tsx",
      resolve(ROOT, "scripts/billing-build-adapter.ts"),
      "--out",
      bundle,
      "--source-out",
      join(temporary, "source.json"),
    ], { cwd: ROOT, windowsHide: true });
    const source = await readFile(bundle, "utf8");
    assert.equal(source.includes("credentialDependencies"), false,
      "the production artifact retained the internal credential dependency seam");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("audit Railway fix review: base provenance refuses truncation and a symlinked member", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "railway-fix-review-provenance-"));
  const provenance = join(temporary, "provenance");
  const stage = async (): Promise<void> => {
    await rm(provenance, { recursive: true, force: true });
    await mkdir(provenance);
    await copyFile(join(BASE_PROVENANCE_FIXTURE, "manifest.json"), join(provenance, "manifest.json"));
    await copyFile(join(BASE_PROVENANCE_FIXTURE, "config.json"), join(provenance, "config.json"));
  };
  try {
    await stage();
    const manifest = await readFile(join(provenance, "manifest.json"));
    await writeFile(join(provenance, "manifest.json"), manifest.subarray(0, manifest.byteLength - 1));
    await assert.rejects(verifyRailwayBaseProvenance(provenance), /Pinned Railway base manifest refused/u);

    await stage();
    await rm(join(provenance, "config.json"));
    const target = join(temporary, "symlink-target");
    await mkdir(target);
    await symlink(target, join(provenance, "config.json"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(verifyRailwayBaseProvenance(provenance), /provenance blob refused/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
