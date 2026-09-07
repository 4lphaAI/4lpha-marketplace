import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeFunctionData, hashTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { from as portoKeyFrom } from "porto/viem/Key";
import { validatePortoPrepareOnlyResult } from "../src/billing/productionExpiryProbe.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const COLLECTOR = "0xc2bdfba7753416fa21e20b5f3dca54a00cff939c" as Address;
const ORCHESTRATOR = "0xaf140d0416a994aebb3fa6212b16ce6700f09751" as Address;
const ACCOUNT = privateKeyToAccount(`0x${"00".repeat(31)}01` as Hex);
const ABI = [{ type: "function", name: "payInvoice", stateMutability: "payable",
  inputs: [{ name: "invoiceId", type: "bytes32" }, { name: "quoteExpiresAt", type: "uint64" }], outputs: [] }] as const;
const CALLDATA = encodeFunctionData({ abi: ABI, functionName: "payInvoice",
  args: [`0x${"44".repeat(32)}`, 1_100n] });
const INPUT = { wallet: WALLET, collector: COLLECTOR, calldata: CALLDATA,
  valueWei: 5n, sessionPublicKey: ACCOUNT.publicKey } as const;

function substitutedPrepare(): unknown {
  const permissions = { calls: [{ signature: "payInvoice(bytes32,uint64)" as const, to: COLLECTOR }],
    spend: [{ limit: 100n, period: "day" as const }] };
  const key = portoKeyFrom({ expiry: 1_200, permissions, publicKey: ACCOUNT.publicKey,
    role: "session", type: "secp256k1" });
  const typedData = { domain: { name: "Altana", version: "0.5.5", chainId: 56,
    verifyingContract: ORCHESTRATOR }, message: { value: `0x${"11".repeat(32)}` },
    primaryType: "Intent", types: { Intent: [{ name: "value", type: "bytes32" }] } } as const;
  const executionData = encodeAbiParameters([{ type: "tuple[]", components: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ] }], [[{ target: COLLECTOR, value: 5n, data: CALLDATA }]]);
  const quote = { ttl: 1_080, quotes: [{ chainId: 56, orchestrator: ORCHESTRATOR,
    unreviewedSelectedQuoteMember: "accepted",
    intent: { eoa: WALLET, executionData, expiry: 1_070n,
      nonce: "not-canonical", orchestrator: "0x2222222222222222222222222222222222222222",
      version: "substituted" } }] };
  return { capabilities: { quote }, context: { quote }, digest: hashTypedData(typedData), key, typedData };
}

test("audit: prepare-only expiry evidence must reject substituted Porto intent identity", () => {
  assert.throws(
    () => validatePortoPrepareOnlyResult(INPUT, substitutedPrepare()),
    /identity drifted|ambiguous/,
  );
});
