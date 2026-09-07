import { featureFixture } from "./support/tradeFeatures.js";
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Address } from "viem";
import { decodeFeature, assessMomentum, enrichFeatures, featurePrompt, selectFeaturePools, type FeatureInterval } from "../src/trade/features.js";
import { rankDiversified, selectEntryCandidates, createTradeVerdictCache, type PinnedCandidate } from "../src/trade/universe.js";
import { EQUITY_WRAPPERS } from "../src/trade/classification.js";
import { compareTradeEvidence } from "../src/trade/comparison.js";
import type { TradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
const addr = (n: number) => `0x${n.toString(16).padStart(40,"0")}` as Address;
const now = 1_800_000_090_000;
const pool = {pool: addr(1),tokenAddress: addr(2),currency: "usd" as const};

it("valid v2 features preserve units, missing RVOL and momentum incompleteness",()=>{
  const raw=featureFixture("15m");const fast=decodeFeature(raw,pool,"15m",now)!;
  const slow=decodeFeature(featureFixture("1h"),pool,"1h",now)!;
  assert.equal(assessMomentum({"15m":fast,"1h":slow},now).status,"pass");
  assert.equal(assessMomentum({"15m":fast,"1h":{...slow,pool:{...pool,pool:addr(9)}}},now).status,"unavailable");
  raw.metrics.rvol20.value=NaN; const partial=decodeFeature(raw,pool,"15m",now)!;
  assert.equal(partial.metrics.rvol20.value,null);assert.equal(partial.metrics.ema12.value,2);
  assert.equal(assessMomentum({"15m":partial,"1h":slow},now).status,"unavailable");
  assert.equal(featurePrompt({"15m":fast},fast.expiresAt),"");
});
it("rejects wrong feature identities, future/stale/unclosed and malformed metric evidence",()=>{
  const mutations=[{identity:{...featureFixture("15m").identity,chainId:1}}, {identity:{...featureFixture("15m").identity,baseAddress:addr(4)}},
    {identity:{...featureFixture("15m").identity,poolAddress:addr(4)}},{identity:{...featureFixture("15m").identity,priceCurrency:"token"}},
    {identity:{...featureFixture("15m").identity,interval:"1h"}},{calculatedAt:now+1},{evaluationClose:now-1},{expiresAt:now},
    {snapshotId:"prompt injection"}];
  for(const mutation of mutations) assert.equal(decodeFeature({...featureFixture("15m"),...mutation},pool,"15m",now),null);
  const raw=featureFixture("15m");raw.metrics.atrPct.value=-1;raw.metrics.ema12.unit="token";
  const decoded=decodeFeature(raw,pool,"15m",now)!;assert.equal(decoded.metrics.atrPct.available,false);assert.equal(decoded.metrics.ema12.available,false);
});
const reads: TradeDataPlaneReads={async universe(){return []},async tokensBatch(){return []},async eligibilityBatch(){return []},async security(){return null}};
it("feature enrichment max3 reads, other models zero, outage fallback and abort",async()=>{
  let calls=0;const dp={...reads,async featurePools(){calls++;return {pools:[pool]}},async featuresBatch(_p:readonly Address[],interval:FeatureInterval){calls++;return {[pool.pool]:{data:featureFixture(interval)}}}};
  assert.equal((await enrichFeatures(dp,"sigma",[pool.tokenAddress],now)).size,1);assert.equal(calls,3);
  await enrichFeatures(dp,"degen",[pool.tokenAddress],now);assert.equal(calls,3);
  assert.equal((await enrichFeatures({...dp,async featurePools(){throw Error("outage")}},"sigma",[pool.tokenAddress],now)).size,0);
  const abort=new AbortController();abort.abort();await assert.rejects(enrichFeatures(dp,"sigma",[pool.tokenAddress],now,abort.signal));
  assert.deepEqual(selectFeaturePools({pools:Array(11).fill(pool)},[pool.tokenAddress]),[]);
});
const candidate=(n:number,lane:PinnedCandidate["lane"]="allowlist"):PinnedCandidate=>({address:addr(n),symbol:"NVDAx",lane,marketCapUsd:2e9,priceUsd:1,volume24hUsd:n,holders:1,priceChange24hPct:1});
it("diversifies exact equity identities, never symbols, and reaches token69 through50+19",async()=>{
  const equity={...candidate(1),address:[...EQUITY_WRAPPERS][0] as Address,volume24hUsd:1e12};
  const rows=rankDiversified("sigma",[equity,candidate(2),candidate(3,"meme")]);
  assert.equal(rows[0]!.address,addr(2));assert.equal(rows[1]!.address,equity.address);assert.equal(rows[2]!.address,addr(3));
  const batches:number[]=[];let scans=0;const candidates=Array.from({length:69},(_,i)=>candidate(i+100));
  const result=await selectEntryCandidates({model:"sigma",settings:{minMarketCapUsd:null,maxMarketCapUsd:null,noReentry:false},candidates,
    pinnedAddresses:new Set(candidates.map(c=>c.address)),previouslyEnteredAddresses:new Set(),openPositionAddresses:new Set(),forbiddenAddresses:new Set(),usEquityAddresses:new Set(),nowMs:now,verdictCache:createTradeVerdictCache(),
    dataPlane:{...reads,async tokensBatch(addresses){batches.push(addresses.length);return addresses.map(address=>({...candidate(Number.parseInt(address.slice(-4),16)),address}))},
      async eligibilityBatch(addresses){batches.push(addresses.length);return addresses.map(address=>({address,eligible:true,reason:"ok",source:"allowlist" as const,venue:null}))},async security(){scans++;return {riskLevel:"ok",flags:[]}}}});
  assert.deepEqual(batches,[50,50,19,19]);assert.equal(result.kind,"selected");if(result.kind==="selected") assert.equal(result.candidates[0]!.address,addr(168));assert.equal(scans,12);
});
const research=()=>({version:"trade-comparison-v1",label:"FIXTURE",decisionAt:now,currency:"BNB",notional:1,candidates:[{token:addr(2),eligible:true,eligibilityObservedAt:now,
  baselineLlm:{selected:true,observationId:"base",observedAt:now},enrichedLlm:{selected:true,observationId:"enriched",observedAt:now},pool,
  features:{"15m":featureFixture("15m"),"1h":featureFixture("1h")},outcome:{notional:1,currency:"BNB",entryAt:now,exitAt:now+1,observedAt:now+2,evidence:"verified",proceeds:1.2,costs:{kind:"actual",relay:.01,platform:.02,model:.03,other:0}}}]});
it("offline matched arms disclose costs and reject lookahead, unequal basis and reused decisions",()=>{
  const result=compareTradeEvidence(research()) as {arms:Record<string,{net:number,costBasis:string}>};
  for(const arm of Object.values(result.arms)){assert.ok(Math.abs(arm.net-.14)<1e-12);assert.equal(arm.costBasis,"actual")}
  for(const mutation of [(r:ReturnType<typeof research>)=>{r.candidates[0]!.outcome.notional=2},(r:ReturnType<typeof research>)=>{r.candidates[0]!.outcome.costs.relay=-1},
    (r:ReturnType<typeof research>)=>{r.candidates[0]!.baselineLlm.observedAt=now+1},(r:ReturnType<typeof research>)=>{r.candidates[0]!.enrichedLlm.observationId="base"}]){const r=research();mutation(r);assert.throws(()=>compareTradeEvidence(r));}
  const missing={...research(),candidates:[{...research().candidates[0],outcome:null}]};
  assert.equal((compareTradeEvidence(missing) as {arms:{baseline:{net:null}}}).arms.baseline.net,null);
});

it("comparison labels quoted estimates and rejects delayed model evidence and aggregate overflow",()=>{
  const quoted=research();quoted.candidates[0]!.outcome.evidence="quoted";quoted.candidates[0]!.outcome.costs.kind="estimated";
  const result=compareTradeEvidence(quoted) as {arms:{baseline:{outcomeBasis:string,costBasis:string,deployedNotional:number}}};
  assert.equal(result.arms.baseline.outcomeBasis,"includes-quotes");assert.equal(result.arms.baseline.costBasis,"includes-estimates");assert.equal(result.arms.baseline.deployedNotional,1);
  const late=research();late.candidates[0]!.enrichedLlm.observedAt=now-1;late.candidates[0]!.eligibilityObservedAt=now-2;assert.throws(()=>compareTradeEvidence(late));
  const invalidCalculation={...featureFixture("15m"),calculatedAt:now-1};assert.equal(decodeFeature(invalidCalculation,pool,"15m",now),null);
  const huge=research();huge.notional=1e308;huge.candidates[0]!.outcome.notional=1e308;
  const duplicated={...huge,candidates:[...huge.candidates,{...huge.candidates[0],token:addr(9),features:undefined,pool:undefined}]};assert.throws(()=>compareTradeEvidence(duplicated));
});

it("empty comparison arms do not claim observed costs or verified fills",()=>{
  const input=research();input.candidates[0]!.eligible=false;
  const result=compareTradeEvidence(input) as {arms:Record<string,{outcomeBasis:string,costBasis:string}>};
  for(const arm of Object.values(result.arms)){assert.equal(arm.outcomeBasis,"no-trades");assert.equal(arm.costBasis,"no-trades");}
});
