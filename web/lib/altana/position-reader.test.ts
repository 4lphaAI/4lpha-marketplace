import { expect, it } from "vitest";
import { ContractFunctionRevertedError, encodeErrorResult, type PublicClient } from "viem";
import { readOnChainPosition } from "./position-reader";
import { WBNB_56, USDT_56, NFPM_56 } from "@/lib/exec/pairs";

function fixture(failure?: "block" | "position" | "slot" | "burned" | "revert") {
  const reads:Record<string,unknown>[]=[];
  const client={ getBlockNumber:async()=>{if(failure==="block")throw Error("transport");return 100n;},readContract:async(args:Record<string,unknown>)=>{
    reads.push(args);
    if(args.functionName==="positions") {
      if(failure==="position")throw Error("transport");
      if(failure==="burned" || failure==="revert")throw new ContractFunctionRevertedError({abi:[],functionName:"positions",data:encodeErrorResult({abi:[{type:"error",name:"Error",inputs:[{name:"message",type:"string"}]}],errorName:"Error",args:[failure==="burned"?"Invalid token ID":"denied"]})});
      return [0n,NFPM_56,USDT_56,WBNB_56,500,-100,100,1000000000000000000n,0n,0n,0n,0n];
    }
    if(failure==="slot")throw Error("slot unavailable");
    return [1n<<96n,0,0,0,0,0,true];
  }} as unknown as PublicClient;
  return {client,reads};
}
it("pins positions and slot0 to a block obtained first; percentages can use that exact sqrt price",async()=>{
  const f=fixture(),p=await readOnChainPosition(f.client,NFPM_56,7n);
  expect(f.reads.map(r=>r.blockNumber)).toEqual([100n,100n]);expect(p.kind).toBe("position");
  if(p.kind==="position"){expect(p.sqrtPriceX96).toBe(1n<<96n);expect(p.amountsAvailable).toBe(true);expect(p.blockNumber).toBe(100n);expect(p.readAtMs).toBeGreaterThan(0);}
});
it.each(["block","position","revert"] as const)("%s failure is unreadable, never burned",async failure=>expect((await readOnChainPosition(fixture(failure).client,NFPM_56,7n)).kind).toBe("unreadable"));
it("positive nonexistent-NFT contract evidence is burned",async()=>expect((await readOnChainPosition(fixture("burned").client,NFPM_56,7n)).kind).toBe("burned"));
it("unreadable slot preserves positive liquidity but cannot authorize a zero-floor close",async()=>{
  const p=await readOnChainPosition(fixture("slot").client,NFPM_56,7n);expect(p.kind).toBe("position");
  if(p.kind==="position"){expect(p.liquidity).toBeGreaterThan(0n);expect(p.amountsAvailable).toBe(false);expect(p.minimums).toEqual({amount0:0n,amount1:0n});}
});
