import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionData, getAddress, http, parseAbi, type Abi, type Address, type Hex } from "viem";
import { buildIncreaseAllowanceCall } from "../src/trade/cmcOwnerService.js";
import { CMC_PERMIT2 } from "../src/trade/cmcCapability.js";

const TOKEN_SOURCE = `pragma solidity 0.8.30; contract AdditiveToken { mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance; function mint(address to,uint256 amount) external { balanceOf[to]+=amount; } function approve(address spender,uint256 amount) external returns(bool) { allowance[msg.sender][spender]=amount; return true; } function increaseAllowance(address spender,uint256 amount) external returns(bool) { allowance[msg.sender][spender]+=amount; return true; } function transferFrom(address from,address to,uint256 amount) external returns(bool) { require(balanceOf[from]>=amount && allowance[from][msg.sender]>=amount); balanceOf[from]-=amount; allowance[from][msg.sender]-=amount; balanceOf[to]+=amount; return true; } }`;
const SPENDER_SOURCE = `pragma solidity 0.8.30; interface T { function transferFrom(address,address,uint256) external returns(bool); } contract Spender { function consume(address token,address from,uint256 amount) external { require(T(token).transferFrom(from,address(this),amount)); } }`;
type Artifact = { readonly abi: Abi; readonly bytecode: Hex };
type TestClient = {
  request(input: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
  sendTransaction(input: unknown): Promise<Hex>;
  waitForTransactionReceipt(input: { readonly hash: Hex }): Promise<{ readonly contractAddress: Address | null }>;
  writeContract(input: unknown): Promise<Hex>;
  readContract(input: unknown): Promise<unknown>;
};
type Solc = { readonly default: { compile(input: string): string; version(): string } };
const CHAIN = { id: 31_337, name: "CMC local EVM", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:0"] } } } as const;
let processHandle: ChildProcess | undefined;
let rpcUrl = "";
let client: TestClient;
let owner: Address;
let token: Address;

function anvilPath(): string {
  const candidate = process.platform === "win32" ? join(homedir(), ".foundry", "bin", "anvil.exe") : join(homedir(), ".foundry", "bin", "anvil");
  return existsSync(candidate) ? candidate : "anvil";
}
async function accounts(url: string): Promise<readonly Address[]> {
  for (let i = 0; i < 150; i += 1) {
    try {
      const read = createPublicClient({ chain: CHAIN, transport: http(url) });
      return (await read.request({ method: "eth_accounts" as never })) as readonly Address[];
    } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error("local EVM did not start");
}
async function compile(): Promise<{ readonly token: Artifact; readonly spender: Artifact }> {
  const module = (await import("solc")) as unknown as Solc;
  if (!module.default.version().startsWith("0.8.30+")) throw new Error("local CMC test requires solc 0.8.30");
  const output = JSON.parse(module.default.compile(JSON.stringify({ language: "Solidity", sources: { "Token.sol": { content: TOKEN_SOURCE }, "Spender.sol": { content: SPENDER_SOURCE } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } }))) as { contracts: Record<string, Record<string, { abi: unknown; evm: { bytecode: { object: string } } }>>; errors?: readonly { severity: string; formattedMessage: string }[] };
  const errors = output.errors?.filter((error) => error.severity === "error") ?? [];
  if (errors.length > 0) throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
  const artifact = (source: string, name: string): Artifact => { const item = output.contracts[source]?.[name]; if (item === undefined) throw new Error("fixture compile failed"); return { abi: item.abi as Abi, bytecode: `0x${item.evm.bytecode.object}` as Hex }; };
  return { token: artifact("Token.sol", "AdditiveToken"), spender: artifact("Spender.sol", "Spender") };
}

before(async () => {
  const port = 24_000 + (process.pid % 2_000);
  rpcUrl = `http://127.0.0.1:${port}`;
  processHandle = spawn(anvilPath(), ["--silent", "--host", "127.0.0.1", "--port", String(port)], { stdio: "ignore", windowsHide: true });
  const found = await accounts(rpcUrl);
  const address = found[0];
  if (address === undefined) throw new Error("anvil has no unlocked account");
  owner = getAddress(address);
  const chain = { ...CHAIN, rpcUrls: { default: { http: [rpcUrl] } } };
  client = createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as TestClient;
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: owner });
  const artifacts = await compile();
  const deploy = async (artifact: Artifact): Promise<Address> => {
    const hash = await wallet.sendTransaction({ data: artifact.bytecode });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.contractAddress === null) throw new Error("fixture deployment failed");
    return receipt.contractAddress;
  };
  token = await deploy(artifacts.token);
  await wallet.writeContract({ address: token, abi: artifacts.token.abi, functionName: "mint", args: [owner, 2n] });
  await wallet.writeContract({ address: token, abi: artifacts.token.abi, functionName: "approve", args: [CMC_PERMIT2, 2n] });
  await client.request({ method: "anvil_impersonateAccount", params: [CMC_PERMIT2] });
  await client.request({ method: "anvil_setBalance", params: [CMC_PERMIT2, "0x3635C9ADC5DEA00000"] });
  await client.request({ method: "eth_sendTransaction", params: [{ from: CMC_PERMIT2, to: token, data: encodeFunctionData({ abi: parseAbi(["function transferFrom(address,address,uint256) returns(bool)"]), functionName: "transferFrom", args: [owner, CMC_PERMIT2, 2n] }) }] });
});
after(() => { if (processHandle !== undefined && processHandle.exitCode === null) processHandle.kill(); });

test("CMC top-up calldata is additive after an intervening Permit2 spend", async () => {
  const topup = buildIncreaseAllowanceCall({ amountWei: 1n });
  assert.equal(topup.data.slice(0, 10), "0x39509351");
  const decoded = decodeFunctionData({ abi: parseAbi(["function increaseAllowance(address,uint256) returns(bool)"]), data: topup.data });
  assert.equal(decoded.args[0].toLowerCase(), CMC_PERMIT2.toLowerCase());
  // The fixture executes the exact calldata produced by the owner call builder;
  // the local token address replaces the real token target only for the EVM test.
  await client.request({ method: "eth_sendTransaction", params: [{ from: owner, to: token, data: topup.data }] });
  const allowance = await client.readContract({ address: token, abi: parseAbi(["function allowance(address,address) view returns(uint256)"]), functionName: "allowance", args: [owner, CMC_PERMIT2] });
  assert.equal(allowance, 1n);
});
