import { describe, expect, it } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { bsc } from "viem/chains";
import type { OnChainPosition } from "@/lib/altana/position-reader";
import { WBNB_56, USDT_56, poolAddressFor } from "@/lib/exec/pairs";
import { readLpAccounting, matchingLpAccounting, lpAccountingPnl, lpAccountingFees, selectLpAccountingPosition, type LpAccountingRead } from "./accounting";
const E = 10n**18n, WALLET = "0x1111111111111111111111111111111111111111", NFPM = "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364";
const p: OnChainPosition = { kind:"position",tokenId:42n,blockNumber:1234n,readAtMs:1000,
  token0:USDT_56,token1:WBNB_56,fee:100,liquidity:1000n,tickLower:-10,tickUpper:10,
  amountsAvailable:true,sqrtPriceX96:1n<<96n,amounts:{amount0:5n*E,amount1:4n*E},minimums:{amount0:1n,amount1:1n},
  owed:{amount0:123n*E,amount1:456n*E} }; // Deliberately different: not an extra fee term.
const read: Extract<LpAccountingRead,{kind:"read"}> = {kind:"read",wallet:WALLET,pool:poolAddressFor(p.token0,p.token1,p.fee)!,
  position:p,collectible0:E,collectible1:0n,dust0:2n*E,dust1:0n};
const metric = (r=read,budget=10n*E) => lpAccountingPnl(r,budget.toString(),3_000_000n);
describe("LP gross accounting", () => {
  it("includes full collectible and dust exactly once and derives USD and % from identical holdings", () => {
    expect(metric()).toEqual({value:"+$6.00",rawWei:(2n*E).toString(),reason:null,note:"+20.00%"});
    expect(metric(read,15n*E)).toEqual({value:"-$9.00",rawWei:(-3n*E).toString(),reason:null,note:"-20.00%"});
    expect(metric(read,12n*E).value).toBe("$0.00");
  });
  it("collecting or compounding fees does not change gross holdings", () => {
    expect(metric({...read,collectible0:0n,dust0:3n*E})).toEqual(metric());
    expect(metric({...read,collectible0:0n,position:{...p,amounts:{amount0:6n*E,amount1:4n*E}}})).toEqual(metric());
  });
  it("supports reversed orientation without converting through floating point", () => {
    const inverse: typeof read = {...read,position:{...p,token0:WBNB_56,token1:USDT_56,amounts:{amount0:4n*E,amount1:5n*E}},
      collectible0:0n,collectible1:E,dust0:0n,dust1:2n*E};
    expect(metric(inverse)).toEqual(metric());
  });
  it("never substitutes partial holdings or missing capital/USD as zero", () => {
    expect(lpAccountingPnl(null,"1",1n).value).toBeNull();
    expect(lpAccountingPnl(read,"0",1n).value).toBeNull();
    expect(lpAccountingPnl(read,"1",null).value).toBeNull();
  });
  it("rejects wrong wallet, pool, NFT and stale/future snapshots", () => {
    const input = {read,wallet:WALLET,pool:read.pool,tokenId:42n,nowMs:2000};
    expect(matchingLpAccounting(input)).toBe(read);
    for (const overrides of [{wallet:USDT_56},{pool:USDT_56},{tokenId:2n},{nowMs:61001},{nowMs:999}]) {
      expect(matchingLpAccounting({...input,...overrides})).toBeNull();
    }
  });
  it("selects a unique discovered replacement, deduplicates IDs and refuses multiple live NFTs", () => {
    expect(selectLpAccountingPosition([{...p,liquidity:0n}, {...p,tokenId:43n}])?.tokenId).toBe(43n);
    expect(selectLpAccountingPosition([p,p])).toBe(p);
    expect(selectLpAccountingPosition([p,{...p,tokenId:43n}])).toBeNull();
  });
  it("formats full collectible-only fallback in quote/base order with tiny nonzero values", () => {
    const r={...read,collectible0:2n*E,collectible1:1n};
    expect(lpAccountingFees(r,{decimals0:18,decimals1:18,symbol0:"USDT",symbol1:"WBNB",quoteIsToken0:true,wbnbMicros:1_000_000n}))
      .toMatchObject({value:"$2.00",tokenBreakdown:"2 USDT / <0.001 WBNB"});
    expect(lpAccountingFees({...r,collectible1:0n},{decimals0:18,decimals1:18,symbol0:"USDT",symbol1:"WBNB",quoteIsToken0:false,wbnbMicros:1_000_000n}).tokenBreakdown)
      .toBe("0 WBNB / 2 USDT");
  });
});
function clientFixture(failCollect=false,wrongOwner=false,inventory: "one" | "unreadable" | "two" | "partial" = "one") {
  const requests: {method:string;params:readonly unknown[] | undefined}[]=[];
  const client=createPublicClient({chain:bsc,transport:custom({request:async ({method,params})=>{
    requests.push({method,params:params as readonly unknown[] | undefined});
    if(method==="eth_chainId") return "0x38";
    if(method!=="eth_call") throw new Error("Unexpected non-read RPC");
    const call=(params as readonly [{data:Hex;to:string;from?:string},string])[0];
    if(call.data.startsWith(toFunctionSelector("ownerOf(uint256)"))) return encodeAbiParameters([{type:"address"}],[wrongOwner?USDT_56:WALLET]);
    if(call.to.toLowerCase()===NFPM && call.data.startsWith(toFunctionSelector("balanceOf(address)"))) {
      if(inventory==="unreadable") throw new Error("inventory unavailable");
      return encodeAbiParameters([{type:"uint256"}],[inventory==="one"?1n:2n]);
    }
    if(call.data.startsWith(toFunctionSelector("tokenOfOwnerByIndex(address,uint256)"))) {
      const index=BigInt(`0x${call.data.slice(-64)}`);
      if(inventory==="partial" && index===1n) throw new Error("index unavailable");
      return encodeAbiParameters([{type:"uint256"}],[42n+index]);
    }
    if(call.data.startsWith(toFunctionSelector("positions(uint256)"))) return encodeAbiParameters(
      [{type:"uint96"},{type:"address"},{type:"address"},{type:"address"},{type:"uint24"},{type:"int24"},{type:"int24"},{type:"uint128"},{type:"uint256"},{type:"uint256"},{type:"uint128"},{type:"uint128"}],
      [0n,WALLET,USDT_56,WBNB_56,100,-10,10,1000n,0n,0n,0n,0n]);
    if(call.data.startsWith(toFunctionSelector("collect((uint256,address,uint128,uint128))"))) {
      expect(call.from?.toLowerCase()).toBe(WALLET);
      if(failCollect) throw new Error("simulation unavailable");
      return encodeAbiParameters([{type:"uint256"},{type:"uint256"}],[E,0n]);
    }
    if(call.data.startsWith(toFunctionSelector("balanceOf(address)"))) return encodeAbiParameters([{type:"uint256"}],[call.to.toLowerCase()===USDT_56?2n*E:0n]);
    throw new Error("Unexpected call");
  }},{retryCount:0})});
  return {client,requests};
}
describe("same-block readonly LP snapshot",()=>{
  it("simulates full collect and reads both wallet legs at the existing principal snapshot block",async()=>{
    const {client,requests}=clientFixture();
    expect(await readLpAccounting(client,NFPM,WALLET,p)).toEqual(read);
    const calls=requests.filter(r=>r.method==="eth_call");
    expect(calls).toHaveLength(6);
    expect(calls.every(r=>r.params?.[1]==="0x4d2")).toBe(true);
    expect(p.owed.amount0).toBe(123n*E);
    expect(p.minimums.amount0).toBe(1n);
  });
  it("does not replace an unreadable collect or wrong owner with zero fees",async()=>{
    for(const options of [[true,false],[false,true]] as const){
      const {client}=clientFixture(options[0],options[1]);
      expect((await readLpAccounting(client,NFPM,WALLET,p)).kind).toBe("unavailable");
    }
  });
  it("does not treat missing, partial or multiple-position inventory as a single-NFT total",async()=>{
    for(const inventory of ["unreadable","partial","two"] as const){
      const {client}=clientFixture(false,false,inventory);
      expect((await readLpAccounting(client,NFPM,WALLET,p)).kind).toBe("unavailable");
    }
  });
});
