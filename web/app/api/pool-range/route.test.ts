import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { poolAddressFor, USDT_56, WBNB_56 } from "@/lib/exec/pairs";
const address=poolAddressFor(USDT_56,WBNB_56,500)!;
const query=`address=${address}&tickLower=-100&tickUpper=100&capitalUsd=20`;
afterEach(()=>vi.unstubAllGlobals());
it.each(["address=bad",`address=${WBNB_56}`,query.replace("-100","-99"),query.replace("=100&","=887273&"),query.replace("Usd=20","Usd=0"),query.replace("Usd=20","Usd=Infinity"),query.replace("tickLower=-100&","")])("rejects unsupported or invalid request before fetching: %s",async q=>{
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);const response=await GET(new NextRequest(`https://local.invalid/api/pool-range?${q}`));const body=await response.json();expect(body.data.unavailable.length).toBeGreaterThan(0);expect(fetch).not.toHaveBeenCalled();
});
it("BFF resolves pool-order metadata server-side and preserves fallback provenance",async()=>{
  const fetch=vi.fn(async(_url: string)=>new Response(JSON.stringify({data:{pool:address,fee:500,requested:{capitalUsd:20},ticks:{lower:-100,upper:100,spacing:10},estimatedAprPct:null,estimatedApr7dPct:null,basis:{lpFeeApr24h:4,lpFeeApr7d:3,tvlUsd:100000},inRange:true,unavailable:["position unavailable"],assumptions:["before IL"]},meta:{asOf:Date.now(),staleness:"fresh",source:"pancake"}}),{status:200}));
  vi.stubGlobal("fetch",fetch);const response=await GET(new NextRequest(`https://local.invalid/api/pool-range?${query}&decimals0=6&decimals1=0`));
  const body=await response.json();expect(body.data.basis.lpFeeApr24h).toBe(4);expect(body.data.meta.source).toBe("pancake");expect(body.data.unavailable).toEqual(["position unavailable"]);
  const url=new URL(String(fetch.mock.calls[0]?.[0]));expect(Number(url.searchParams.get("lower"))).toBeCloseTo(1.0001**-100,10);expect(url.searchParams.has("decimals0")).toBe(false);
});
it.each(["http","invalid-json","invalid-response"])("BFF names %s failures",async kind=>{
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(kind==="invalid-json"?"not json":"null",{status:kind==="http"?503:200})));
  const body=await (await GET(new NextRequest(`https://local.invalid/api/pool-range?${query}`))).json();expect(body.data.unavailable[0]).toMatch(/http|invalid response/);
});
