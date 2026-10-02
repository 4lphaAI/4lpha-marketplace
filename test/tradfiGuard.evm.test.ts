import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  TRADFI_BINANCE_ROUTER_SELECTOR,
  TRADFI_BINANCE_FLASH_ROUTER_56,
  TRADFI_BINANCE_FLASH_SPENDER_56,
  TRADFI_GUARD_CHAIN_ID,
  TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC,
  TRADFI_GUARD_MAX_CALLDATA_BYTES,
  TRADFI_SWAP_GUARD_ABI,
  assertTradfiGuardIdentity,
  assertTradfiGuardRuntimeTemplate,
  buildTradfiGuardSwapCall,
} from "../src/trade/guard.js";

function resolveAnvil(): string {
  const configured = process.env["ANVIL_PATH"]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const candidates = process.platform === "win32"
    ? [join(homedir(), ".foundry", "bin", "anvil.exe"), join(homedir(), ".foundry", "bin", "anvil")]
    : [join(homedir(), ".foundry", "bin", "anvil"), "/usr/local/bin/anvil"];
  const local = candidates.find((candidate) => existsSync(candidate));
  return local ?? "anvil";
}
const CHAIN = {
  id: 31_337,
  name: "TradFi guard local EVM",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:0"] } },
} as const;

const FIXTURE_SOURCE = `
pragma solidity 0.8.30;

interface GuardToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract GuardMockToken {
    mapping(address => uint256) private balances;
    mapping(address => mapping(address => uint256)) private allowances;
    uint256 public transferFromFeeBps;
    uint256 public transferFeeBps;
    bool public noReturn;
    bool public rejectZero;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return allowances[owner][spender];
    }

    function setFees(uint256 fromBps, uint256 toBps) external {
        require(fromBps <= 10_000 && toBps <= 10_000);
        transferFromFeeBps = fromBps;
        transferFeeBps = toBps;
    }

    function setNoReturn(bool value) external { noReturn = value; }
    function setRejectZero(bool value) external { rejectZero = value; }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (amount == 0 && rejectZero) return false;
        allowances[msg.sender][spender] = amount;
        if (noReturn) assembly { return(0, 0) }
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balances[msg.sender] >= amount);
        balances[msg.sender] -= amount;
        uint256 received = amount - (amount * transferFeeBps / 10_000);
        balances[to] += received;
        if (noReturn) assembly { return(0, 0) }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowances[from][msg.sender] >= amount && balances[from] >= amount);
        allowances[from][msg.sender] -= amount;
        balances[from] -= amount;
        uint256 received = amount - (amount * transferFromFeeBps / 10_000);
        balances[to] += received;
        if (noReturn) assembly { return(0, 0) }
        return true;
    }
}

contract GuardMockSpender {
    address public router;
    function setRouter(address value) external { router = value; }

    function spend(
        address tokenIn,
        address tokenOut,
        address guard,
        uint256 amount,
        uint256 outputAmount,
        address outputRecipient
    ) external {
        require(msg.sender == router);
        GuardToken(tokenIn).transferFrom(guard, address(this), amount);
        if (outputAmount != 0) GuardToken(tokenOut).transfer(outputRecipient, outputAmount);
    }
}

contract GuardMockRouter {
    address public spender;
    address public guard;
    address public tokenIn;
    address public tokenOut;
    uint256 public spendAmount;
    uint256 public outputAmount;
    address public outputRecipient;
    bool public reenter;
    bool public rejectCleanup;

    function setConfig(
        address guard_,
        address tokenIn_,
        address tokenOut_,
        uint256 spendAmount_,
        uint256 outputAmount_,
        address outputRecipient_,
        bool reenter_,
        bool rejectCleanup_
    ) external {
        guard = guard_;
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        spendAmount = spendAmount_;
        outputAmount = outputAmount_;
        outputRecipient = outputRecipient_;
        reenter = reenter_;
        rejectCleanup = rejectCleanup_;
    }

    function setSpender(address value) external { spender = value; }

    fallback() external {
        require(msg.sig == bytes4(0xad43f73d));
        if (rejectCleanup) GuardMockToken(tokenIn).setRejectZero(true);
        if (reenter) {
            (bool nested,) = guard.call(
                abi.encodeWithSignature(
                    "swap(address,address,uint256,uint256,uint256,bytes)",
                    tokenIn,
                    tokenOut,
                    1,
                    1,
                    block.timestamp + 1,
                    bytes(abi.encodePacked(bytes4(0xad43f73d)))
                )
            );
            require(nested);
        }
        address recipient = outputRecipient == address(0) ? guard : outputRecipient;
        if (spender == address(this)) {
            GuardToken(tokenIn).transferFrom(guard, address(this), spendAmount);
            if (outputAmount != 0) GuardToken(tokenOut).transfer(recipient, outputAmount);
        } else {
            GuardMockSpender(spender).spend(
                tokenIn,
                tokenOut,
                guard,
                spendAmount,
                outputAmount,
                recipient
            );
        }
    }
}
`;

type SolcArtifact = Readonly<{
  abi: readonly unknown[];
  evm: Readonly<{
    bytecode: Readonly<{ object: string }>;
    deployedBytecode: Readonly<{ object: string }>;
  }>;
}>;
type SolcOutput = Readonly<{
  errors?: readonly Readonly<{ severity: string; formattedMessage: string }>[];
  contracts?: Readonly<Record<string, Readonly<Record<string, SolcArtifact>>>>;
}>;
type SolcModule = Readonly<{
  default: Readonly<{ version(): string; compile(input: string): string }>;
}>;
type Artifact = Readonly<{ abi: Abi; bytecode: Hex; runtime: Hex }>;
type LocalPublicClient = Readonly<{
  waitForTransactionReceipt(input: { readonly hash: Hex }): Promise<LocalReceipt>;
  readContract(input: { readonly address: Address; readonly abi: Abi; readonly functionName: string; readonly args?: readonly unknown[] }): Promise<unknown>;
  getBytecode(input: { readonly address: Address }): Promise<Hex | undefined>;
  getBlock(): Promise<Readonly<{ timestamp: bigint }>>;
  request(input: { readonly method: string; readonly params: readonly unknown[] }): Promise<unknown>;
}>;
type LocalWalletClient = Readonly<{
  sendTransaction(input: { readonly account: Address; readonly to?: Address; readonly data?: Hex; readonly value?: bigint }): Promise<Hex>;
}>;

type RpcAccountResult = readonly string[];
type LocalReceipt = Readonly<{ contractAddress?: Address | null; status: string }>;

let processHandle: ChildProcess | undefined;
let spawnError: Error | null = null;
let rpcUrl = "";
let owner: Address;
let secondOwner: Address;
let publicClient: LocalPublicClient;
let walletClient: LocalWalletClient;
let guard: Address;
let tokenIn: Address;
let tokenOut: Address;
let router: Address;
let spender: Address;
let tokenAbi: Abi;
let routerAbi: Abi;
let spenderAbi: Abi;
let artifacts: Readonly<Record<string, Artifact>>;

function fixtureCall(abi: Abi, functionName: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi, functionName, args: args as never }) as Hex;
}

async function rpcAccounts(url: string): Promise<RpcAccountResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }),
  });
  const body = (await response.json()) as { readonly result?: unknown };
  return Array.isArray(body.result) && body.result.every((value) => typeof value === "string")
    ? body.result
    : [];
}

async function send(
  request: { readonly to?: Address; readonly data?: Hex; readonly value?: bigint },
): Promise<Hex> {
  return walletClient.sendTransaction({ account: owner, ...request });
}

async function wait(hash: Hex): Promise<LocalReceipt> {
  return await publicClient.waitForTransactionReceipt({ hash }) as unknown as LocalReceipt;
}

async function deploy(name: string): Promise<Address> {
  const artifact = artifacts[name];
  if (artifact === undefined) throw new Error(`fixture artifact missing: ${name}`);
  const hash = await send({ data: artifact.bytecode });
  const receipt = await wait(hash);
  if (receipt.status !== "success" || receipt.contractAddress === undefined || receipt.contractAddress === null) {
    throw new Error(`fixture deploy failed: ${name}`);
  }
  return getAddress(receipt.contractAddress);
}

async function configure(
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  await wait(await send({ to: address, data: fixtureCall(abi, functionName, args) }));
}

async function mint(address: Address, to: Address, amount: bigint): Promise<void> {
  await configure(address, tokenAbi, "mint", [to, amount]);
}

async function approve(address: Address, spenderAddress: Address, amount: bigint): Promise<void> {
  await configure(address, tokenAbi, "approve", [spenderAddress, amount]);
}

async function setRouterConfig(
  amountIn: bigint,
  outputAmount: bigint,
  options: Readonly<{ recipient?: Address; reenter?: boolean; rejectCleanup?: boolean }> = {},
): Promise<void> {
  await configure(router, routerAbi, "setConfig", [
    guard,
    tokenIn,
    tokenOut,
    amountIn,
    outputAmount,
    options.recipient ?? "0x0000000000000000000000000000000000000000",
    options.reenter ?? false,
    options.rejectCleanup ?? false,
  ]);
}

async function currentTimestamp(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

// Pins the timestamp anvil will stamp on the NEXT mined block. Applies once —
// call it again before each block whose timestamp must be pinned.
async function pinNextBlockTimestamp(value: bigint): Promise<void> {
  await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [`0x${value.toString(16)}`] });
}

function guardCall(
  input: Address,
  output: Address,
  amount: bigint,
  minOut: bigint,
  deadline: bigint,
  data: Hex = TRADFI_BINANCE_ROUTER_SELECTOR,
): Hex {
  return buildTradfiGuardSwapCall({
    guard,
    router,
    spender,
    canonicalUSDT: tokenIn,
    tokenIn: input,
    tokenOut: output,
    amountInWei: amount,
    minOutWei: minOut,
    deadline,
    calldata: data,
  }).data as Hex;
}

async function expectRevert(action: () => Promise<unknown>): Promise<void> {
  let completed = false;
  try {
    const result = await action();
    if (typeof result === "string" && result.startsWith("0x")) {
      const receipt = await wait(result as Hex);
      completed = receipt.status === "success";
    } else {
      completed = true;
    }
  } catch {
    // A reverted local transaction is the expected result.
  }
  assert.equal(completed, false, "expected the local EVM transaction to revert");
}

before(async () => {
  const port = 20_000 + (process.pid % 4_000);
  rpcUrl = `http://127.0.0.1:${port}`;
  processHandle = spawn(resolveAnvil(), ["--silent", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: "ignore",
    windowsHide: true,
  });
  processHandle.once("error", (error) => { spawnError = error; });
  let accounts: RpcAccountResult = [];
  for (let attempt = 0; attempt < 150 && accounts.length === 0; attempt += 1) {
    try { accounts = await rpcAccounts(rpcUrl); } catch { /* process is still starting */ }
    if (accounts.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (spawnError !== null) throw new Error(`local EVM could not start: ${spawnError.message}`);
  if (accounts.length < 2) throw new Error("local EVM did not expose two unlocked accounts");
  owner = getAddress(accounts[0]!);
  secondOwner = getAddress(accounts[1]!);
  const chain = { ...CHAIN, rpcUrls: { default: { http: [rpcUrl] } } };
  publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as LocalPublicClient;
  walletClient = createWalletClient({ chain, transport: http(rpcUrl) }) as unknown as LocalWalletClient;

  const guardSource = await readFile(new URL("../contracts/TradFiSwapGuard.sol", import.meta.url), "utf8");
  const module = (await import("solc")) as unknown as SolcModule;
  const compiler = module.default;
  if (!compiler.version().startsWith("0.8.30+")) throw new Error("local guard test requires solc 0.8.30");
  const output = JSON.parse(compiler.compile(JSON.stringify({
    language: "Solidity",
    sources: {
      "TradFiSwapGuard.sol": { content: guardSource },
      "GuardFixtures.sol": { content: FIXTURE_SOURCE },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
      evmVersion: "paris",
      metadata: { bytecodeHash: "none", appendCBOR: false },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  }))) as SolcOutput;
  const errors = output.errors?.filter((entry) => entry.severity === "error") ?? [];
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  const makeArtifact = (sourceName: string, name: string): Artifact => {
    const value = output.contracts?.[sourceName]?.[name];
    if (value === undefined) throw new Error(`compiled artifact missing: ${name}`);
    return {
      abi: value.abi as Abi,
      bytecode: `0x${value.evm.bytecode.object}` as Hex,
      runtime: `0x${value.evm.deployedBytecode.object}` as Hex,
    };
  };
  artifacts = {
    TradFiSwapGuard: makeArtifact("TradFiSwapGuard.sol", "TradFiSwapGuard"),
    GuardMockToken: makeArtifact("GuardFixtures.sol", "GuardMockToken"),
    GuardMockSpender: makeArtifact("GuardFixtures.sol", "GuardMockSpender"),
    GuardMockRouter: makeArtifact("GuardFixtures.sol", "GuardMockRouter"),
  };
  tokenAbi = artifacts.GuardMockToken!.abi;
  routerAbi = artifacts.GuardMockRouter!.abi;
  spenderAbi = artifacts.GuardMockSpender!.abi;

  tokenIn = await deploy("GuardMockToken");
  tokenOut = await deploy("GuardMockToken");
  spender = await deploy("GuardMockSpender");
  router = await deploy("GuardMockRouter");
  await configure(spender, spenderAbi, "setRouter", [router]);
  await configure(router, routerAbi, "setSpender", [spender]);
  const guardArtifact = artifacts.TradFiSwapGuard!;
  const constructorData = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [router, spender, tokenIn],
  );
  const guardHash = await send({ data: `${guardArtifact.bytecode}${constructorData.slice(2)}` as Hex });
  const guardReceipt = await wait(guardHash);
  if (guardReceipt.contractAddress === undefined || guardReceipt.contractAddress === null) throw new Error("guard deploy failed");
  guard = getAddress(guardReceipt.contractAddress);
  await configure(router, routerAbi, "setConfig", [guard, tokenIn, tokenOut, 0n, 0n, "0x0000000000000000000000000000000000000000", false, false]);
});

after(() => {
  if (processHandle !== undefined && processHandle.exitCode === null) processHandle.kill();
});

test("guard compiles with a pinned runtime and exposes only the reviewed immutable swap surface", async () => {
  const runtime = artifacts.TradFiSwapGuard!.runtime;
  assert.ok(runtime.length > 2);
  const deployedRuntime = await publicClient.getBytecode({ address: guard });
  if (deployedRuntime === undefined) throw new Error("guard runtime is missing");
  assert.doesNotThrow(() => assertTradfiGuardRuntimeTemplate(runtime, deployedRuntime));
  assert.equal(
    await publicClient.readContract({
      address: guard,
      abi: TRADFI_SWAP_GUARD_ABI,
      functionName: "PINNED_ROUTER_SELECTOR",
    }) as Hex,
    TRADFI_BINANCE_ROUTER_SELECTOR,
  );
  assert.equal(await publicClient.readContract({ address: guard, abi: TRADFI_SWAP_GUARD_ABI, functionName: "router" }), router);
  assert.equal(await publicClient.readContract({ address: guard, abi: TRADFI_SWAP_GUARD_ABI, functionName: "spender" }), spender);
  assert.equal(await publicClient.readContract({ address: guard, abi: TRADFI_SWAP_GUARD_ABI, functionName: "MAX_DEADLINE_WINDOW" }), TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC);
});

test("deployment identity validation accepts only the reviewed current target and spender", () => {
  const identity = {
    chainId: TRADFI_GUARD_CHAIN_ID,
    guard,
    router: TRADFI_BINANCE_FLASH_ROUTER_56,
    spender: TRADFI_BINANCE_FLASH_SPENDER_56,
    canonicalUSDT: tokenIn,
  } as const;
  assert.doesNotThrow(() => assertTradfiGuardIdentity(identity, identity));
  assert.throws(
    () => assertTradfiGuardIdentity(identity, { ...identity, router }),
    /reviewed current Flash identity/,
  );
  assert.throws(
    () => assertTradfiGuardIdentity(identity, { ...identity, spender: router }),
    /reviewed current Flash identity/,
  );
  assert.throws(
    () => assertTradfiGuardIdentity(identity, { ...identity, chainId: 97 }),
    /chain 56/,
  );
});

test("the pure builder bounds opaque calldata before a proxy request", () => {
  const base = {
    guard,
    router,
    spender,
    canonicalUSDT: tokenIn,
    tokenIn,
    tokenOut,
    amountInWei: 1n,
    minOutWei: 1n,
    deadline: 1n,
  } as const;
  const exact = `0xad43f73d${"00".repeat(TRADFI_GUARD_MAX_CALLDATA_BYTES - 4)}` as Hex;
  assert.equal(buildTradfiGuardSwapCall({ ...base, calldata: exact }).value, 0n);
  assert.throws(
    () => buildTradfiGuardSwapCall({ ...base, calldata: `${exact}00` as Hex }),
    /at most 65536 bytes/,
  );
  assert.throws(
    () => buildTradfiGuardSwapCall({ ...base, calldata: "0x810c705" as Hex }),
    /at least a four-byte selector/,
  );
});

test("exact funding, output floor, caller refund, and allowance cleanup succeed on the local EVM", async () => {
  const amount = 10n ** 18n;
  const output = 2n * 10n ** 18n;
  await mint(tokenIn, owner, amount);
  await mint(tokenOut, spender, output);
  await approve(tokenIn, guard, amount);
  await setRouterConfig(amount, output);
  const deadline = (await currentTimestamp()) + 10n;
  const receipt = await wait(await send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, deadline) }));
  assert.equal(receipt.status, "success");
  assert.equal(await publicClient.readContract({ address: tokenIn, abi: tokenAbi, functionName: "balanceOf", args: [owner] }), 0n);
  assert.equal(await publicClient.readContract({ address: tokenOut, abi: tokenAbi, functionName: "balanceOf", args: [owner] }), output);
  assert.equal(await publicClient.readContract({ address: tokenIn, abi: tokenAbi, functionName: "allowance", args: [guard, spender] }), 0n);
});

test("partial spend refunds only new input and keeps prior balances out of the fill", async () => {
  const amount = 10n ** 18n;
  const spend = 6n * 10n ** 17n;
  const output = 3n * 10n ** 17n;
  const dust = 7n;
  await mint(tokenIn, owner, amount);
  await mint(tokenOut, guard, dust);
  await mint(tokenOut, spender, output);
  await approve(tokenIn, guard, amount);
  await setRouterConfig(spend, output);
  const deadline = (await currentTimestamp()) + 10n;
  const ownerOutputBefore = await publicClient.readContract({ address: tokenOut, abi: tokenAbi, functionName: "balanceOf", args: [owner] }) as bigint;
  await wait(await send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, deadline) }));
  assert.equal(await publicClient.readContract({ address: tokenIn, abi: tokenAbi, functionName: "balanceOf", args: [owner] }), amount - spend);
  assert.equal(await publicClient.readContract({ address: tokenOut, abi: tokenAbi, functionName: "balanceOf", args: [owner] }), ownerOutputBefore + output);
  assert.equal(await publicClient.readContract({ address: tokenOut, abi: tokenAbi, functionName: "balanceOf", args: [guard] }), dust);
});

test("wrong recipient, expired call, short output, and donated dust all revert", async () => {
  const amount = 10n;
  const output = 10n;
  await mint(tokenIn, owner, amount * 4n);
  await approve(tokenIn, guard, amount * 4n);
  await mint(tokenOut, spender, output * 2n);
  const guardOutputBefore = await publicClient.readContract({ address: tokenOut, abi: tokenAbi, functionName: "balanceOf", args: [guard] }) as bigint;
  await mint(tokenOut, guard, 100n);
  await mint(tokenIn, guard, 17n);
  await setRouterConfig(amount + 1n, output);
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) }));
  assert.equal(await publicClient.readContract({ address: tokenIn, abi: tokenAbi, functionName: "balanceOf", args: [guard] }), 17n);

  await setRouterConfig(amount, output, { recipient: secondOwner });
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) }));

  await setRouterConfig(amount, output);
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) - 1n) }));

  // R2.9/C3: the UPPER bound the clamp relies on. Nothing in the earlier cases
  // exercised `deadline > block.timestamp + MAX_DEADLINE_WINDOW`; only the
  // already-past case above did. `currentTimestamp()` reads the LATEST block
  // before the guard call mines a new one; anvil stamps that new block with
  // the wall clock at mining time, so deriving the deadline from a read-then-
  // wall-clock gap is flaky at the exact +16/+15 boundary (any second crossed
  // between the read and the mine turns the intended-invalid +16 into a valid
  // +15). Pin the next block's timestamp instead and derive both edges from
  // that pinned value so the boundary is exact regardless of scheduling.
  await setRouterConfig(amount, output); // mines a block — pin AFTER it, not before
  const pinned = (await currentTimestamp()) + 100n;
  await pinNextBlockTimestamp(pinned);
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, pinned + TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC + 1n) }));
  assert.equal(await currentTimestamp(), pinned); // the reverting block really carried the pinned time

  await setRouterConfig(amount, output);
  const pinnedEdge = (await currentTimestamp()) + 100n;
  await pinNextBlockTimestamp(pinnedEdge);
  const edgeReceipt = await wait(await send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, pinnedEdge + TRADFI_GUARD_MAX_DEADLINE_WINDOW_SEC) }));
  assert.equal(edgeReceipt.status, "success"); // exactly +15 is still admitted
  assert.equal(await currentTimestamp(), pinnedEdge); // the successful block really carried the pinned time

  await setRouterConfig(amount, output - 1n);
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) }));

  await setRouterConfig(amount, 0n);
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, 1n, (await currentTimestamp()) + 10n) }));
  assert.equal(await publicClient.readContract({ address: tokenOut, abi: tokenAbi, functionName: "balanceOf", args: [guard] }), guardOutputBefore + 100n);
});

test("same, zero, native-value, and unpinned opaque calls are refused", async () => {
  const amount = 1n;
  const deadline = (await currentTimestamp()) + 10n;
  await expectRevert(() => send({ to: guard, data: guardCall(tokenIn, tokenIn, amount, 1n, deadline) }));
  await expectRevert(() => send({ to: guard, data: guardCall("0x0000000000000000000000000000000000000000", tokenOut, amount, 1n, deadline) }));
  await expectRevert(() => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, 1n, deadline, "0xdeadbeef") }));
  await expectRevert(() => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, 1n, deadline, "0x810c705b") }));
  await expectRevert(() => send({ to: guard, value: 1n, data: guardCall(tokenIn, tokenOut, amount, 1n, deadline) }));
});

test("taxed input and taxed output cannot satisfy the exact measured boundary", async () => {
  const amount = 1_000n;
  const output = 1_000n;
  await mint(tokenIn, owner, amount);
  await mint(tokenOut, spender, output);
  await approve(tokenIn, guard, amount);
  await configure(tokenIn, tokenAbi, "setFees", [100n, 0n]);
  await setRouterConfig(amount, output);
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) }));

  await configure(tokenIn, tokenAbi, "setFees", [0n, 0n]);
  await configure(tokenOut, tokenAbi, "setFees", [0n, 100n]);
  await mint(tokenIn, owner, amount);
  await approve(tokenIn, guard, amount);
  await mint(tokenOut, spender, output);
  await setRouterConfig(amount, output);
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) }));
});

test("non-returning approvals work, failed cleanup reverts, and reentry is blocked", async () => {
  const amount = 100n;
  const output = 100n;
  await configure(tokenIn, tokenAbi, "setFees", [0n, 0n]);
  await configure(tokenOut, tokenAbi, "setFees", [0n, 0n]);
  await configure(tokenIn, tokenAbi, "setNoReturn", [true]);
  await configure(tokenOut, tokenAbi, "setNoReturn", [true]);
  await mint(tokenIn, owner, amount * 2n);
  await mint(tokenOut, spender, output * 2n);
  await approve(tokenIn, guard, amount);
  await setRouterConfig(amount, output);
  await wait(await send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) }));
  assert.equal(await publicClient.readContract({ address: tokenIn, abi: tokenAbi, functionName: "allowance", args: [guard, spender] }), 0n);

  await configure(tokenIn, tokenAbi, "setNoReturn", [false]);
  await approve(tokenIn, guard, amount);
  await mint(tokenIn, owner, amount);
  await mint(tokenOut, spender, output);
  await setRouterConfig(amount, output, { rejectCleanup: true });
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) }));
  assert.equal(await publicClient.readContract({ address: tokenIn, abi: tokenAbi, functionName: "allowance", args: [guard, spender] }), 0n);
  await configure(tokenIn, tokenAbi, "setRejectZero", [false]);

  await approve(tokenIn, guard, amount);
  await mint(tokenIn, owner, amount);
  await mint(tokenOut, spender, output);
  await setRouterConfig(amount, output, { reenter: true });
  await expectRevert(async () => send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) }));
});

test("two unlocked wallets settle sequentially with isolated output and caller attribution", async () => {
  const amount = 77n;
  const output = 88n;
  await configure(tokenIn, tokenAbi, "setNoReturn", [false]);
  await configure(tokenOut, tokenAbi, "setNoReturn", [false]);
  await mint(tokenIn, owner, amount);
  await mint(tokenIn, secondOwner, amount);
  await approve(tokenIn, guard, amount);
  await setRouterConfig(amount, output);
  await mint(tokenOut, spender, output);
  const ownerOutputBefore = await publicClient.readContract({ address: tokenOut, abi: tokenAbi, functionName: "balanceOf", args: [owner] }) as bigint;
  await wait(await send({ to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) }));

  const secondWallet = createWalletClient({ chain: { ...CHAIN, rpcUrls: { default: { http: [rpcUrl] } } }, transport: http(rpcUrl) }) as unknown as LocalWalletClient;
  await secondWallet.sendTransaction({ account: secondOwner, to: tokenIn, data: fixtureCall(tokenAbi, "approve", [guard, amount]) });
  await configure(router, routerAbi, "setConfig", [guard, tokenIn, tokenOut, amount, output, "0x0000000000000000000000000000000000000000", false, false]);
  await mint(tokenOut, spender, output);
  const hash = await secondWallet.sendTransaction({ account: secondOwner, to: guard, data: guardCall(tokenIn, tokenOut, amount, output, (await currentTimestamp()) + 10n) });
  await wait(hash);
  assert.equal(await publicClient.readContract({ address: tokenOut, abi: tokenAbi, functionName: "balanceOf", args: [owner] }), ownerOutputBefore + output);
  assert.equal(await publicClient.readContract({ address: tokenOut, abi: tokenAbi, functionName: "balanceOf", args: [secondOwner] }), output);
});

test("the router may also be the immutable approval spender when the deployment proves that identity", async () => {
  const amount = 31n;
  const output = 41n;
  const guardArtifact = artifacts.TradFiSwapGuard!;
  const constructorData = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [router, router, tokenIn],
  );
  const deployHash = await send({ data: `${guardArtifact.bytecode}${constructorData.slice(2)}` as Hex });
  const deployed = await wait(deployHash);
  if (deployed.contractAddress === undefined || deployed.contractAddress === null) throw new Error("same-spender guard deploy failed");
  const sameGuard = getAddress(deployed.contractAddress);
  await configure(router, routerAbi, "setSpender", [router]);
  await configure(router, routerAbi, "setConfig", [sameGuard, tokenIn, tokenOut, amount, output, "0x0000000000000000000000000000000000000000", false, false]);
  await mint(tokenIn, owner, amount);
  await mint(tokenOut, router, output);
  await approve(tokenIn, sameGuard, amount);
  const deadline = (await currentTimestamp()) + 10n;
  await wait(await send({ to: sameGuard, data: buildTradfiGuardSwapCall({
    guard: sameGuard,
    router,
    spender: router,
    canonicalUSDT: tokenIn,
    tokenIn,
    tokenOut,
    amountInWei: amount,
    minOutWei: output,
    deadline,
    calldata: TRADFI_BINANCE_ROUTER_SELECTOR,
  }).data as Hex }));
  assert.equal(await publicClient.readContract({ address: tokenIn, abi: tokenAbi, functionName: "allowance", args: [sameGuard, router] }), 0n);
});
