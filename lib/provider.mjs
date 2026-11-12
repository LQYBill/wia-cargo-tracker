import {parse17} from './model.mjs';
export function createProvider(store,{token=process.env.TRACK17_TOKEN,interval=1800000,fetchImpl=fetch}={}) {
 let busy=false,activeId=null;
 async function api(method,s) {
  const body={number:s.number};if(s.carrier_code)body.carrier=s.carrier_code;
  const r=await fetchImpl('https://api.17track.net/track/v2.4/'+method,{method:'POST',headers:{'Content-Type':'application/json','17token':token},body:JSON.stringify([body]),signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('17TRACK HTTP '+r.status);
  const data=await r.json(); if(data.code!==0)throw Error('17TRACK 返回错误代码 '+String(data.code));
  const ok=data.data?.accepted?.find(x=>x.number===s.number);
  if(!ok)throw Error('17TRACK 未接受此单号；请核对单号、承运商代码及账号额度');
  return {ok,data};
 }
 async function sync(id) {
  if(!token)throw Error('尚未配置 17TRACK 接口；可使用官网查询并手动录入节点');
  if(busy)throw Error('其他同步正在进行，请稍后再试');
  const s=store.get(id);if(!s||s.deleted_at)throw Error('运单不存在');
  if(s.next_sync>Date.now())throw Error('未到下次允许查询时间，请稍后再试');
  busy=true;activeId=id;
  store.db.prepare('UPDATE shipments SET next_sync=? WHERE id=?').run(Date.now()+interval,id);
  try {
   if(!s.registered) {await api('register',s);store.db.prepare('UPDATE shipments SET registered=1 WHERE id=?').run(id);}
   const {ok,data}=await api('gettrackinfo',s);
   const events=parse17(ok,s.carrier);
   if(!events.length)throw Error('接口尚无含有效时间的轨迹；保留原有数据');
   const result=store.ingest(id,events,data);
   store.db.prepare('UPDATE shipments SET last_sync=?,error=NULL WHERE id=?').run(new Date().toISOString(),id);
   return result;
  } catch(e) {
   store.db.prepare('UPDATE shipments SET error=? WHERE id=?').run(e.message,id);throw e;
  } finally{busy=false;activeId=null;}
 }
 async function tick() {
  if(!token||busy)return;
  const due=store.list().filter(s=>s.enabled&&s.metrics.status!=='delivered'&&s.next_sync<=Date.now());
  for(const s of due.slice(0,10)) {try{await sync(s.id);}catch{} }
 }
 return {sync,tick,isSyncing:id=>activeId===id,isBusy:()=>busy};
}
