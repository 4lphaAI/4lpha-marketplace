import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { custom, encodeAbiParameters, padHex, keccak256, stringToBytes, type Address, type Hex, type TransactionReceipt } from "viem";
import { bsc } from "viem/chains";
import { createLpChainReaders, decodeLpFeeReceipt, NFPM_DECREASE_LIQUIDITY_TOPIC } from "../src/lp/readers.js";
import { parseLpFeesTelemetry } from "../src/lp/feeTelemetry.js";
import { MemoryLpObservationStore, PostgresLpObservationStore, parseLpTriggerObservation } from "../src/store/lpObservations.js";
import type { LpTriggerObservation } from "../src/lp/triggers.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { MemoryLpFeeEventStore, feeCoverage, sumFeeRows, type LpFeeEvent } from "../src/store/lpFeeEvents.js";

const NFPM_COLLECT_TOPIC = keccak256(stringToBytes("Collect(uint256,address,uint256,uint256)"));
const owner = "0x1111111111111111111111111111111111111111" as const;
const nfpm = "0x2222222222222222222222222222222222222222" as const;
const tx = `0x${"ab".repeat(32)}` as Hex;
function log(kind: "collect" | "decrease", token = 7n, a = 10n, b = 20n) {
  return { address: nfpm as Address, topics: [kind === "collect" ? NFPM_COLLECT_TOPIC : NFPM_DECREASE_LIQUIDITY_TOPIC, padHex(`0x${token.toString(16)}`)],
    data: kind === "collect" ? encodeAbiParameters([{type:"address"},{type:"uint256"},{type:"uint256"}],[owner,a,b])
      : encodeAbiParameters([{type:"uint128"},{type:"uint256"},{type:"uint256"}],[1n,a,b]),
    transactionHash: tx, blockNumber: 100n, removed: false };
}
function receipt(logs = [log("collect")]): TransactionReceipt {
  return { status:"success", transactionHash:tx, blockNumber:100n, logs } as unknown as TransactionReceipt;
}
describe("LP detail receipt accounting", () => {
  it("pins DecreaseLiquidity topic", () => assert.equal(NFPM_DECREASE_LIQUIDITY_TOPIC,"0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4"));
  it("collect only subtracts zero", () => assert.deepEqual(decodeLpFeeReceipt(receipt(),nfpm,tx).byTokenId.get("7"),{collected0:10n,collected1:20n,decreased0:0n,decreased1:0n}));
  it("zap-out separates decreased principal", () => assert.equal(decodeLpFeeReceipt(receipt([log("decrease",7n,8n),log("collect")]),nfpm,tx).byTokenId.get("7")?.decreased0,8n));
  it("sums two Collect logs and keeps two NFTs separate", () => {
    const rows=decodeLpFeeReceipt(receipt([log("collect"),log("collect"),log("collect",8n)]),nfpm,tx).byTokenId;
    assert.equal(rows.size,2);assert.equal(rows.get("7")?.collected0,20n);assert.equal(rows.get("8")?.collected0,10n);
  });
  it("zero Collect is evidence; missing matching logs are not", () => {
    assert.equal(decodeLpFeeReceipt(receipt([log("collect",7n,0n,0n)]),nfpm,tx).byTokenId.size,1);
    assert.equal(decodeLpFeeReceipt(receipt([{...log("collect"),address:owner}]),nfpm,tx).byTokenId.size,0);
  });
  for(const [name,change] of [
    ["failed receipt",(r:TransactionReceipt)=>({...r,status:"reverted"})],
    ["wrong hash",(r:TransactionReceipt)=>({...r,transactionHash:`0x${"cc".repeat(32)}`})],
    ["malformed topic",(r:TransactionReceipt)=>({...r,logs:[{...log("collect"),topics:[NFPM_COLLECT_TOPIC,"0x01"]}]})],
    ["malformed data",(r:TransactionReceipt)=>({...r,logs:[{...log("collect"),data:"0x"}]})],
    ["removed log",(r:TransactionReceipt)=>({...r,logs:[{...log("collect"),removed:true}]})],
    ["wrong log block",(r:TransactionReceipt)=>({...r,logs:[{...log("collect"),blockNumber:99n}]})],
  ] as const) it(`rejects ${name}`,()=>assert.throws(()=>decodeLpFeeReceipt(change(receipt()) as unknown as TransactionReceipt,nfpm,tx)));
  it("rejects decrease without paired collect",()=>assert.throws(()=>decodeLpFeeReceipt(receipt([log("decrease")]),nfpm,tx)));
  it("positionFeesAt sends the numeric block to eth_call and latest money reader stays latest",async()=>{
    const blocks:unknown[]=[];
    const readers=createLpChainReaders({network:{chain:bsc,chainId:56,publicRpcUrl:"https://offline.invalid"},nfpm,factory:owner,quoterV2:owner,twapWindowSeconds:300,
      transport:()=>custom({request:async({method,params})=>{if(method==="eth_chainId")return "0x38";if(method==="eth_call"){blocks.push((params as readonly unknown[])[1]);return encodeAbiParameters([{type:"uint256"},{type:"uint256"}],[3n,4n]);}throw Error("unexpected RPC");}})});
    assert.deepEqual(await readers.positionFeesAt!(7n,owner,100n),{amount0Wei:3n,amount1Wei:4n});
    await readers.positionFees(7n,owner); assert.deepEqual(blocks,["0x64","latest"]);
  });
});

const core: LpTriggerObservation = {blockNumber:100n,evaluatedAtMs:1000,poolAddress:owner,tokenId:"7",protectConsecutive:1,protectBreach:"stop-loss",rotationBreach:true,rotationConsecutive:2};
const fees={collectible0Wei:3n,collectible1Wei:4n,blockNumber:100n,tokenId:"7",positionRowVersion:2,asOfMs:1000};
describe("optional LP fees through actual store read paths",()=>{
  for(const backend of ["memory","postgres"] as const) {
    for(const [name,value] of [["valid",fees],["invalid tag",{...fees,collectible0Wei:{$bigint:"invalid"}}],["huge tag",{...fees,collectible0Wei:{$bigint:"1".repeat(5000)}}],["oversized",{...fees,collectible0Wei:1n<<300n}],["negative",{...fees,blockNumber:-1n}],["extra key",{...fees,instructions:"ignored"}]] as const)
      it(`${backend}: ${name} preserves counters and timestamps`,async()=>{
        const store=backend==="memory"?new MemoryLpObservationStore():await PostgresLpObservationStore.create(new FakeSqlClient());
        await store.put({ownerAddress:owner,agentId:"a",positionId:"p",observation:{...core,fees:value} as unknown as LpTriggerObservation});
        assert.deepEqual(await store.get(owner,"a","p"),name==="valid"?{...core,fees}:core);
      });
  }
  it("malformed fees cannot loosen prior protect or valuation rejection",()=>{
    for(const v of [{...core,protectBreach:"bad"},{...core,valuation:{method:"bad"}}])assert.equal(parseLpTriggerObservation({...v,fees:{bad:true}}),parseLpTriggerObservation(v));
  });
  it("parser does not throw on hostile optional shapes",()=>{for(const value of [null,[],0,"bad",{...fees,tokenId:"01"},{...fees,asOfMs:Infinity}])assert.equal(parseLpFeesTelemetry(value),undefined);});
});
export const feeRow = (overrides: Partial<LpFeeEvent> = {}): LpFeeEvent => ({ownerAddress:owner,agentId:"a",positionId:"p",lineageId:"l",sequenceId:"s",journalIdempotencyKey:"k",stepIndex:4,kind:"harvest",tokenId:"7",txHash:tx,blockNumber:100n,collected0Wei:10n,collected1Wei:20n,decreased0Wei:8n,decreased1Wei:17n,realised0Wei:2n,realised1Wei:3n,status:"recorded",reason:null,recordedAtMs:1000,receiptTokenIds:["7"],...overrides});
describe("LP fee ledger coverage boundary",()=>{
  const candidate={sequenceId:"s",journalIdempotencyKey:"k",txHash:tx};
  it("unknown H remains missing even at B=0",()=>assert.equal(feeCoverage([], [candidate],0n).status,"incomplete"));
  it("H>B excluded; H<=B included",()=>{assert.equal(sumFeeRows([feeRow()],"p",99n).realised0Wei,0n);assert.equal(feeCoverage([feeRow()],[candidate],99n).status,"complete");assert.equal(sumFeeRows([feeRow()],"p",100n).realised0Wei,2n);});
  it("wrong hash is not receipt evidence",()=>assert.equal(feeCoverage([feeRow({txHash:`0x${"cd".repeat(32)}`})],[candidate],100n).missing,1));
  it("partial two-NFT receipt cannot certify complete",()=>assert.equal(feeCoverage([feeRow({receiptTokenIds:["7","8"]})],[candidate],100n).missing,1));
  it("replay inserts once and cross owner cannot read",async()=>{const store=new MemoryLpFeeEventStore();await store.recordReceipt([feeRow()]);await store.recordReceipt([feeRow()]);assert.equal((await store.snapshot(owner,"a")).length,1);assert.equal((await store.snapshot(nfpm,"a")).length,0);});
  it("atomic validation refuses all of an incomplete receipt",async()=>{const store=new MemoryLpFeeEventStore();await assert.rejects(store.recordReceipt([feeRow({receiptTokenIds:["7","8"]})]));assert.equal((await store.snapshot(owner,"a")).length,0);});
  it("aggregation exceeds 200-row display and history survives close",async()=>{const store=new MemoryLpFeeEventStore();for(let i=0;i<205;i++)await store.recordReceipt([feeRow({sequenceId:String(i)})]);assert.equal((await store.listFeeEvents(owner,"a","p",999)).length,200);assert.equal((await store.sumFeeEvents(owner,"a","p",{throughBlock:100n})).realised0Wei,410n);await store.close();assert.equal((await store.snapshot(owner,"a")).length,205);});
});
