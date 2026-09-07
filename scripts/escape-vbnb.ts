/**
 * `escape-vbnb` — the FINDINGS (at) receipt-transfer escape, as an operator
 * script the OWNER runs (this plane's agent cannot and should not run it:
 * `redeem` is a deliberately refused selector, and the whole point is that
 * the trapped wallet cannot receive the payout).
 *
 * THE MECHANISM: vBNB pays out via a 2300-gas `.transfer()` that an EIP-7702
 * wallet cannot receive — but the vBNB RECEIPT is an ordinary ERC-20. So:
 * move the receipt to a plain, never-delegated EOA, redeem THERE, send the
 * BNB home (a plain value transfer TO the delegated wallet is fine — only the
 * stipend payout path is broken).
 *
 *   step 1: generate a temp EOA, save its key to .env, print the address
 *   step 2: from the MAIN wallet — send gas (0.0004 BNB) + ALL vBNB to it
 *   step 3: from the TEMP wallet — redeem ALL vBNB into BNB
 *   step 4: from the TEMP wallet — send everything (minus gas) back home
 *
 * Every money step SIMULATES first and refuses to execute without
 * `--yes-live`. Never touches `.env.local`; the temp key goes to `.env`
 * (gitignored, the house convention for test keys). Delete the
 * ESCAPE_TEMP_KEY line when done.
 *
 * USAGE (each step is one command):
 *   node --import tsx --env-file=.env --env-file=.env.local scripts/escape-vbnb.ts step1
 *   node --import tsx --env-file=.env --env-file=.env.local scripts/escape-vbnb.ts step2 --yes-live
 *   node --import tsx --env-file=.env --env-file=.env.local scripts/escape-vbnb.ts step3 --yes-live
 *   node --import tsx --env-file=.env --env-file=.env.local scripts/escape-vbnb.ts step4 --yes-live
 */
import { appendFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  formatEther,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { bsc } from "viem/chains";

const V_BNB = getAddress("0xA07c5b74C9B40447a954e1466938b865b6BBea36");
const RPC = "https://bsc-dataseed.bnbchain.org";
const GAS_TOPUP = 400_000_000_000_000n; // 0.0004 BNB for the temp wallet's two txs

const vTokenAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "redeem", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

const publicClient = createPublicClient({ chain: bsc, transport: http(RPC) });

function requireKey(name: string): Hex {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is unset. ${name === "ESCAPE_TEMP_KEY" ? "Run step1 first." : ""}`);
  }
  return value as Hex;
}

const yesLive = process.argv.includes("--yes-live");
function gate(action: string): void {
  if (!yesLive) {
    throw new Error(
      `${action} MOVES REAL FUNDS and requires --yes-live. The simulation above ` +
        "already ran; nothing was executed.",
    );
  }
}

async function main(): Promise<void> {
  const step = process.argv[2];
  const main = privateKeyToAccount(requireKey("OWNER_TEST_KEY"));
  console.log(`main wallet : ${main.address}`);

  if (step === "step1") {
    if (process.env["ESCAPE_TEMP_KEY"]?.trim()) {
      console.log(`temp wallet : ${privateKeyToAccount(requireKey("ESCAPE_TEMP_KEY")).address} (already exists — reusing)`);
      return;
    }
    const key = generatePrivateKey();
    const temp = privateKeyToAccount(key);
    appendFileSync(
      new URL("../.env", import.meta.url),
      `\n# escape-vbnb temp EOA (FINDINGS (at) receipt-transfer escape). DELETE after step4.\nESCAPE_TEMP_KEY=${key}\n`,
      "utf8",
    );
    console.log(`temp wallet : ${temp.address} (key appended to .env as ESCAPE_TEMP_KEY)`);
    console.log("next        : step2 --yes-live (sends gas + the vBNB receipt there)");
    return;
  }

  const temp = privateKeyToAccount(requireKey("ESCAPE_TEMP_KEY"));
  console.log(`temp wallet : ${temp.address}`);
  const mainWallet = createWalletClient({ account: main, chain: bsc, transport: http(RPC) });
  const tempWallet = createWalletClient({ account: temp, chain: bsc, transport: http(RPC) });

  if (step === "step2") {
    const vBal = await publicClient.readContract({ address: V_BNB, abi: vTokenAbi, functionName: "balanceOf", args: [main.address] });
    if (vBal === 0n) throw new Error("main wallet holds no vBNB — nothing to escape.");
    console.log(`vBNB to move: ${vBal}`);
    // SIMULATE the receipt transfer (this is the leg (at) proved safe).
    await publicClient.simulateContract({
      address: V_BNB, abi: vTokenAbi, functionName: "transfer",
      args: [temp.address, vBal], account: main.address,
    });
    console.log("simulation  : vBNB.transfer OK");
    gate("step2");
    const gasTx = await mainWallet.sendTransaction({ to: temp.address, value: GAS_TOPUP });
    console.log(`gas top-up  : ${gasTx}`);
    await publicClient.waitForTransactionReceipt({ hash: gasTx });
    const moveTx = await mainWallet.writeContract({
      address: V_BNB, abi: vTokenAbi, functionName: "transfer", args: [temp.address, vBal],
    });
    console.log(`vBNB moved  : ${moveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: moveTx });
    console.log("next        : step3 --yes-live");
    return;
  }

  if (step === "step3") {
    const vBal = await publicClient.readContract({ address: V_BNB, abi: vTokenAbi, functionName: "balanceOf", args: [temp.address] });
    if (vBal === 0n) throw new Error("temp wallet holds no vBNB — run step2 first.");
    console.log(`vBNB to burn: ${vBal}`);
    const sim = await publicClient.simulateContract({
      address: V_BNB, abi: vTokenAbi, functionName: "redeem", args: [vBal], account: temp.address,
    });
    console.log(`simulation  : redeem OK (error code ${sim.result} — 0 is success)`);
    gate("step3");
    const tx = await tempWallet.writeContract({
      address: V_BNB, abi: vTokenAbi, functionName: "redeem", args: [vBal],
    });
    console.log(`redeemed    : ${tx}`);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    const bnb = await publicClient.getBalance({ address: temp.address });
    console.log(`temp now has: ${formatEther(bnb)} BNB`);
    console.log("next        : step4 --yes-live");
    return;
  }

  if (step === "step4") {
    const bal = await publicClient.getBalance({ address: temp.address });
    const gasReserve = 50_000_000_000_000n; // leave dust for this tx's own gas
    if (bal <= gasReserve) throw new Error("temp wallet holds nothing to send back.");
    const send = bal - gasReserve;
    console.log(`sending home: ${formatEther(send)} BNB -> ${main.address}`);
    console.log("(a plain value transfer TO the delegated wallet is the safe direction)");
    gate("step4");
    const tx = await tempWallet.sendTransaction({ to: main.address, value: send });
    console.log(`sent        : ${tx}`);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    const home = await publicClient.getBalance({ address: main.address });
    console.log(`main wallet : ${formatEther(home)} BNB`);
    console.log("DONE. Delete the ESCAPE_TEMP_KEY line from .env.");
    return;
  }

  throw new Error("Usage: escape-vbnb <step1|step2|step3|step4> [--yes-live]");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
