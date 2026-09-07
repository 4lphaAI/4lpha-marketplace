import { describe, expect, it } from "vitest";
import { feeMetric, feeUsd, parseFeeEvidence } from "./fees";
import { reviewedRangePool, validateRangeApr } from "./pool-range";
import { freshWbnbPriceMicros, usdForWei } from "@/lib/exec/agent-detail";
import { lpWithdrawOutcome } from "./withdraw";
import { poolAddressFor, WBNB_56, USDT_56, REVIEWED_MAJORS_56 } from "@/lib/exec/pairs";
import { displayOrientation } from "@/components/lp/LiquidityChart";
const now=2000000000000;
const address=poolAddressFor(USDT_56,WBNB_56,500)!;
const request={address,lower:-100,upper:100,capital:100,fee:500,spacing:10};
function apr(){return {data:{pool:address,fee:500,requested:{capitalUsd:100},ticks:{lower:-100,upper:100,spacing:10},estimatedAprPct:12.5,estimatedApr7dPct:null,basis:{lpFeeApr24h:4},inRange:true,unavailable:[],assumptions:["before IL"]},meta:{asOf:now,staleness:"fresh",source:"pancake"}};}
describe("LP detail money and freshness",()=>{
  it.each([["5000000000000000", "$0.01"],["-5000000000000000","-$0.01"],["4999999999999999","$0.00"],["-4999999999999999","$0.00"]])("signed half-away cents %s",(wei,usd)=>expect(usdForWei(wei,1000000n)).toBe(usd));
  it.each([-1,0,60000,60001])("ages upstream fresh WBNB evidence at %d ms",age=>expect(freshWbnbPriceMicros({data:{address:WBNB_56,priceUsd:700},meta:{asOf:now-age,staleness:"fresh",source:"test"}},now)!==null).toBe(age>=0&&age<=60000));
  it("wrong token and stale upstream metadata cannot price WBNB",()=>{for(const [a,s]of [[USDT_56,"fresh"],[WBNB_56,"stale"]])expect(freshWbnbPriceMicros({data:{address:a,priceUsd:700},meta:{asOf:now,staleness:s,source:"test"}},now)).toBeNull();});
  it("WBNB/USDT fees use USDT; BTCB/WBNB uses WBNB; unit flip does not enter USD arithmetic",()=>{
    expect(feeUsd(1n*10n**18n,2n*10n**18n,0,true,18,1000000n)).toBe("$3.00");
    expect(feeUsd(1n*10n**18n,2n*10n**18n,0,false,18,700000000n)).toBe("$2100.00");
    const g={spacing:10,currentTick:100,currentTickAsOfMs:now,orientation:{quoteIsToken0:true,decimals0:18,decimals1:6,symbol0:"USDT",symbol1:"WBNB"},display:{invert:false}};
    expect(displayOrientation(g).quoteIsToken0).toBe(true);expect(displayOrientation({...g,display:{invert:true}}).quoteIsToken0).toBe(false);
    expect(displayOrientation({...g,display:{invert:true}}).decimals1).toBe(6);
  });
  const position={tokenId:"7",rowVersion:1,feeSum:{realised0Wei:"10",realised1Wei:"20",throughBlock:"100",recordedCount:1,gapCount:0},feeCoverage:{status:"complete",reason:"managed",missing:0,gaps:0},observation:{fees:{collectible0Wei:"1",collectible1Wei:"2",tokenId:"7",positionRowVersion:1,blockNumber:"100",asOfMs:now}}};
  const metric=(p=position,imported=false)=>feeMetric({evidence:parseFeeEvidence(p),tokenId:"7",rowVersion:1,imported,tick:0,quoteIsToken0:false,quoteMicros:1000000n,decimals0:18,decimals1:18,symbol0:"A",symbol1:"B"});
  it("combined fees require complete same-B, same-NFT, same-version evidence",()=>{
    expect(metric().value).toBe("$0.00");
    expect(metric({...position,feeCoverage:{...position.feeCoverage,status:"incomplete"}}).value).toBeNull();
    expect(metric({...position,feeSum:{...position.feeSum,throughBlock:"99"}}).value).toBeNull();
    expect(metric({...position,observation:{fees:{...position.observation.fees,tokenId:"8"}}}).value).toBeNull();
    expect(metric({...position,observation:{fees:{...position.observation.fees,positionRowVersion:2}}}).value).toBeNull();
    expect(metric(position,true).reason).toBe("import fee history unavailable");
  });
});
describe("APR reviewed-pair and reason matrix",()=>{
  it("enumerates five pairs at exactly four supported fee tiers",()=>{let count=0;for(const token of Object.keys(REVIEWED_MAJORS_56)){if(token===WBNB_56)continue;for(const fee of [100,500,2500,10000]){const p=reviewedRangePool(poolAddressFor(token,WBNB_56,fee)!);expect(p?.fee).toBe(fee);expect(p!.token0<p!.token1).toBe(true);count++;}}expect(count).toBe(20);expect(reviewedRangePool(WBNB_56)).toBeNull();});
  it("accepts outward rounding only",()=>{const p=apr();p.data.ticks.lower=-110;p.data.ticks.upper=110;expect(validateRangeApr(p,request,now).rounded).toBe(true);p.data.ticks.lower=-90;expect(validateRangeApr(p,request,now).unavailable).toContain("range snapped beyond tolerance");});
  it.each(["pool","fee","spacing","capital","nan","stale","future","old","missing-estimate"])("rejects or labels %s evidence",kind=>{
    const p=apr();if(kind==="pool")p.data.pool=WBNB_56;if(kind==="fee")p.data.fee=100;if(kind==="spacing")p.data.ticks.spacing=1;if(kind==="capital")p.data.requested.capitalUsd=2;if(kind==="nan")p.data.estimatedAprPct=NaN;
    if(kind==="stale")p.meta.staleness="stale";if(kind==="future")p.meta.asOf=now+1;if(kind==="old")p.meta.asOf=now-60001;
    if(kind==="missing-estimate")(p.data as {estimatedAprPct:number|null}).estimatedAprPct=null;
    expect(validateRangeApr(p,request,now).unavailable.length).toBeGreaterThan(0);
  });
});
describe("Withdraw outcome evidence",()=>{
  const exit={sequenceId:"s",status:"completed",code:"OK",reason:"done",confirmedSteps:2,inlineConvert:true,submissionModel:"one or two batches",note:"conversion skipped",inlineResidueBaseWei:"0"};
  it("requires the outcome, preserves note and zero residue without inventing legs",()=>{expect(lpWithdrawOutcome({data:{exit}})).toContain("assets returned to the agent wallet");expect(lpWithdrawOutcome({data:{exit}})).toContain("Residue: 0");expect(lpWithdrawOutcome({data:{exit}})).toContain("conversion skipped");});
  it.each([{data:{}},{data:{replayed:true}},{data:{exit:{status:"completed"}}},{data:{exit:{...exit,status:"nonsense"}}}])("HTTP success/replay/malformed outcome is unavailable",payload=>expect(lpWithdrawOutcome(payload)).toBe("Outcome unavailable — refreshed from the plane"));
  it.each([["held","Exit held"],["rolled-back","Exit refused"]])("%s is not withdrawn",(status,label)=>expect(lpWithdrawOutcome({data:{exit:{...exit,status}}})).toContain(label));
});
