import{randomUUID}from'node:crypto';
export function calendarDay(now,zone){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(x=>[x.type,x.value]));return{date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour),minute:Number(p.minute)};}
function previous(date){return new Date(Date.parse(date+'T12:00:00Z')-86400000).toISOString().slice(0,10);}
export function createNightly(store,provider,{zone=process.env.MONITOR_TIMEZONE||'Europe/Paris',hour=Number(process.env.MONITOR_HOUR||22),clock=()=>Date.now(),autoEnable=true}={}){
 if(!Number.isInteger(hour)||hour<0||hour>23)throw Error('MONITOR_HOUR需为0–23的整点');calendarDay(clock(),zone);
 const db=store.db;let ticking=false,stopped=false;
 db.exec(`CREATE TABLE IF NOT EXISTS monitor_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS monitor_runs(id TEXT PRIMARY KEY,scheduled_key TEXT UNIQUE,started TEXT NOT NULL,finished TEXT,status TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,success INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS monitor_items(run TEXT NOT NULL REFERENCES monitor_runs(id),shipment TEXT NOT NULL REFERENCES shipments(id),status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(run,shipment));`);
 if(!db.prepare("SELECT value FROM monitor_meta WHERE key='activated'").get()){
  db.prepare('INSERT INTO monitor_meta VALUES(?,?)').run('activated',calendarDay(clock(),zone).date);
  if(autoEnable)db.prepare('UPDATE shipments SET enabled=1 WHERE deleted_at IS NULL').run();
 }
 // Single server owns the queue. Interrupted items are retried after restart.
 db.prepare("UPDATE monitor_items SET status='pending' WHERE status='running'").run();
 const active=()=>store.list().filter(s=>s.metrics.status!=='delivered');
 function enqueue(key=null,ids=null){
  const existing=key&&db.prepare('SELECT id FROM monitor_runs WHERE scheduled_key=?').get(key);if(existing)return existing.id;
  const list=ids?active().filter(s=>ids.includes(s.id)):active(),id=randomUUID();
  db.exec('BEGIN IMMEDIATE');try{
   db.prepare('INSERT INTO monitor_runs(id,scheduled_key,started,status,total) VALUES(?,?,?,?,?)').run(id,key,new Date(clock()).toISOString(),list.length?'queued':'completed',list.length);
   const insert=db.prepare('INSERT INTO monitor_items(run,shipment,status) VALUES(?,?,?)');for(const s of list)insert.run(id,s.id,'pending');
   if(!list.length)db.prepare('UPDATE monitor_runs SET finished=? WHERE id=?').run(new Date(clock()).toISOString(),id);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return id;
 }
 async function tick(){
  if(stopped||ticking||provider.isBusy?.())return;ticking=true;try{
   const now=clock(),local=calendarDay(now,zone),due=local.hour>=hour?local.date:previous(local.date),activated=db.prepare("SELECT value FROM monitor_meta WHERE key='activated'").get().value;
   if(due>=activated)enqueue('nightly:'+zone+':'+due);
   const item=db.prepare("SELECT i.*,r.scheduled_key FROM monitor_items i JOIN monitor_runs r ON r.id=i.run WHERE i.status='pending' AND i.retry_at<=? ORDER BY r.started LIMIT 1").get(now);if(!item)return;
   const s=store.get(item.shipment);
   if(!s||s.deleted_at||s.metrics.status==='delivered'){db.prepare("UPDATE monitor_items SET status='skipped' WHERE run=? AND shipment=?").run(item.run,item.shipment);}
   else{
    db.prepare("UPDATE monitor_items SET status='running',attempts=attempts+1 WHERE run=? AND shipment=?").run(item.run,item.shipment);db.prepare("UPDATE monitor_runs SET status='running' WHERE id=?").run(item.run);
    try{await provider.sync(item.shipment);db.prepare("UPDATE monitor_items SET status='success',error=NULL WHERE run=? AND shipment=?").run(item.run,item.shipment);}
    catch(e){const attempts=item.attempts+1;db.prepare('UPDATE monitor_items SET status=?,retry_at=?,error=? WHERE run=? AND shipment=?').run(attempts<3?'pending':'failed',now+attempts*1800000,e.message,item.run,item.shipment);if(attempts===3)db.prepare('INSERT INTO notifications VALUES(?,?,?,?,0)').run(randomUUID(),item.shipment,'官网查询失败，历史轨迹保留，请物流专员核验',new Date(clock()).toISOString());}
   }
   const items=db.prepare('SELECT status,count(*) n FROM monitor_items WHERE run=? GROUP BY status').all(item.run),counts=Object.fromEntries(items.map(x=>[x.status,x.n]));
   const finished=!counts.pending&&!counts.running;
   db.prepare('UPDATE monitor_runs SET success=?,failed=?,status=?,finished=? WHERE id=?').run(counts.success||0,counts.failed||0,finished?(counts.failed?'completed_with_errors':'completed'):'running',finished?new Date(clock()).toISOString():null,item.run);
  }finally{ticking=false;}
 }
 function state(){
  const connection=provider.connection?.()||{ready:true};const local=calendarDay(clock(),zone),nextDate=local.hour<hour?local.date:new Date(Date.parse(local.date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  return{source:'website',schedule:`每天 ${String(hour).padStart(2,'0')}:00（${zone}）`,next:`${nextDate} ${String(hour).padStart(2,'0')}:00`,ready:connection.ready,error:connection.error,siteState:connection.siteState||'unverified',siteError:connection.siteError,active:active().length,pendingRetry:db.prepare("SELECT count(*) n FROM monitor_items WHERE status='pending' AND attempts>0").get().n,runs:db.prepare('SELECT * FROM monitor_runs ORDER BY started DESC LIMIT 10').all(),running:ticking};
 }
 return{tick,enqueue,state,stop:async()=>{stopped=true;while(ticking)await new Promise(r=>setTimeout(r,20));}};
}
