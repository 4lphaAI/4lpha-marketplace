import assert from "node:assert/strict";
import { it } from "node:test";
import { PostgresLpFeeEventStore, MemoryLpFeeEventStore, type LpFeeEvent } from "../src/store/lpFeeEvents.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
const owner="0x1111111111111111111111111111111111111111" as const;
const other="0x2222222222222222222222222222222222222222" as const;
function event(tokenId="7",positionId="p"):LpFeeEvent { return {ownerAddress:owner,agentId:"a",positionId,lineageId:"l",sequenceId:"s",journalIdempotencyKey:"k",stepIndex:3,kind:"grid-shift",tokenId,txHash:`0x${"ab".repeat(32)}`,blockNumber:100n,collected0Wei:10n,collected1Wei:20n,decreased0Wei:8n,decreased1Wei:17n,realised0Wei:2n,realised1Wei:3n,status:"recorded",reason:null,recordedAtMs:1000,receiptTokenIds:["7","8"]}; }
class LedgerSql implements SqlClient {
  rows=new Map<string,{owner:unknown;agent:unknown;record:unknown}>();
  failSecond=false; inserts=0; statements:string[]=[];
  async query<Row>(text:string,params:readonly unknown[]=[]):Promise<SqlResult<Row>> {
    this.statements.push(text);
    if(text.includes("lpFeeEvents.insert")) {
      if(this.failSecond && ++this.inserts===2)throw Error("disk failure");
      const k=JSON.stringify([params[4],params[5],params[6],params[2]]);
      if(!this.rows.has(k))this.rows.set(k,{owner:params[0],agent:params[1],record:JSON.parse(String(params[21])) as unknown});
    }
    if(text.includes("lpFeeEvents.snapshot"))return {rows:[...this.rows.values()].filter(r=>r.owner===params[0]&&r.agent===params[1]).map(r=>({record:r.record})) as Row[]};
    return {rows:[]};
  }
  async transaction<T>(fn:(tx:SqlClient)=>Promise<T>): Promise<T> {const before=structuredClone(this.rows);try{return await fn(this);}catch(e){this.rows=before;throw e;}}
  async close(){}
}
it("Postgres real record/snapshot/list/sum paths keep owner scope, exact bigints and full receipt atomically",async()=>{
  const sql=new LedgerSql(),store=await PostgresLpFeeEventStore.create(sql),rows=[event(),event("8","p2")];
  await store.recordReceipt(rows);await store.recordReceipt(rows);
  assert.deepEqual(await store.snapshot(owner,"a"),rows);
  assert.deepEqual(await store.snapshot(other,"a"),[]);assert.deepEqual(await store.snapshot(owner,"other"),[]);
  assert.equal((await store.listFeeEvents(owner,"a","p",200)).length,1);
  assert.equal((await store.sumFeeEvents(owner,"a","p2",{throughBlock:100n})).realised0Wei,2n);
  assert.match(sql.statements.find(s=>s.includes("lpFeeEvents.snapshot"))!,/where owner_address=\$1 and agent_id=\$2/u);
  assert.match(sql.statements[0]!,/unique\(sequence_id, journal_idempotency_key, token_id, position_id\)/u);
  assert.match(sql.statements.find(s => s.includes("lpFeeEvents.insert"))!, /on conflict\(sequence_id,journal_idempotency_key,token_id,position_id\) do nothing/u);
  await store.close();assert.equal((await store.snapshot(owner,"a")).length,2);
});
it("Postgres a second NFT write failure rolls back the first NFT too",async()=>{
  const sql=new LedgerSql(),store=await PostgresLpFeeEventStore.create(sql);sql.failSecond=true;
  await assert.rejects(store.recordReceipt([event(),event("8","p2")]),/disk failure/);
  assert.deepEqual(await store.snapshot(owner,"a"),[]);
});
it("both stores persist one gap row per affected position atomically",async()=>{
  for(const store of [new MemoryLpFeeEventStore(),await PostgresLpFeeEventStore.create(new LedgerSql())]) {
    const gap=(positionId:string):LpFeeEvent=>({...event("-",positionId),status:"gap",reason:"attribution-unavailable"});
    const gaps = [gap("p"), gap("p2")];
    await store.recordReceipt(gaps);
    await store.recordReceipt(gaps);
    assert.deepEqual(await store.snapshot(owner,"a"), gaps);
    const recorded = [event(), event("8", "p2")].map(r => ({...r, sequenceId: "recorded"}));
    await store.recordReceipt(recorded);
    await store.recordReceipt(recorded);
    assert.deepEqual(await store.snapshot(owner,"a"), [...gaps, ...recorded]);
    await assert.rejects(store.recordReceipt([gap("p3"), {...gap("p4"), realised0Wei: 999n}]));
    assert.deepEqual(await store.snapshot(owner,"a"), [...gaps, ...recorded]);
  }
});
